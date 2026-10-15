// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The serve loop of a funding provider's worker: it takes the sessions and
 * quote asks the host hands the provider, runs each session through the
 * provider's handlers, and turns how a session ends into its final report.
 *
 * @module
 */
import type {
    FundingAssignment,
    FundingQuoteAnswer,
    FundingQuoteAsk,
    HostFundingServeSubscribeItem,
} from "@parity/truapi";
import { type Logger, createLogger } from "@parity/product-sdk-logger";

import { HostUnavailableError } from "../errors.js";
import { getClientSync } from "../transport.js";
import { type FundingClient, call } from "./client.js";
import { FundingAbortedError, FundingFailed, SessionOverError, hostErrorTag } from "./errors.js";
import { refuse } from "./quotes.js";
import { DEFAULT_FUNDING_TIMING, FundingSession, type FundingTiming } from "./session.js";
import type { SavedStateSpec } from "./state.js";

/** What a provider's worker does with the sessions and asks the host hands it. */
export interface FundingProviderHandlers<S> {
    /**
     * Price an ask. A throw, or no answer within `quoteDeadlineMs`, answers
     * `Refused { Unavailable }`. Use `validateAsk` and `refuse` for refusals.
     */
    onQuote(
        ask: FundingQuoteAsk,
        context: QuoteContext,
    ): FundingQuoteAnswer | Promise<FundingQuoteAnswer>;
    /**
     * Run one session to its end. Called again for the same intent after a
     * restart, with `session.state` as last checkpointed. Resolve when the
     * provider has no more work on it: for a withdrawal, after the payout and
     * any refund. Call `session.fail(reason)` to end it as `Failed`; any other
     * throw hands the session out again later.
     */
    onAssigned(session: FundingSession<S>): Promise<void>;
    /**
     * The user asked to cancel. Return whether to stop; the default stops
     * while `session.cancellable`. Stopping aborts `session.signal`, and the
     * session is reported `Failed { Cancelled }`.
     */
    onCancel?(session: FundingSession<S>): boolean;
}

/** Context for answering one ask. */
export interface QuoteContext {
    askId: string;
    /** Aborted at the quote deadline. */
    signal: AbortSignal;
}

/** Options for {@link serveFunding}. */
export interface ServeFundingOptions<S> {
    /** How the provider's saved state is versioned, created and migrated. */
    state: SavedStateSpec<S>;
    /** Stops serving: unsubscribes and aborts every session without reporting a cancel. */
    signal?: AbortSignal;
    /** Waits and retries; see {@link FundingTiming} for the defaults. */
    timing?: Partial<FundingTiming>;
    logger?: Logger;
    /** The host client; the cached TruAPI client by default. A test passes a fake. */
    client?: FundingClient;
}

/** A running serve loop. */
export interface FundingServer {
    /** Resolves once `signal` stops the loop. */
    readonly done: Promise<void>;
    /** Intents of the sessions running now. */
    readonly running: ReadonlySet<string>;
}

interface Running<S> {
    session: FundingSession<S>;
    controller: AbortController;
    cancelRequested: boolean;
}

/**
 * Serve the funding sessions the host assigns to this provider.
 *
 * The host replays every session still in flight, and every ask not yet
 * answered, each time the stream opens, so a worker that restarts carries on
 * where it stopped. A session that crashes is dropped and handed out again by
 * reopening the stream, after a doubling wait.
 *
 * @throws HostUnavailableError outside a host container, when no `client` is given.
 *
 * @example
 * ```ts
 * import { serveFunding, validateAsk, quoted } from "@parity/product-sdk-host/funding-provider";
 *
 * serveFunding<CardState>(
 *     {
 *         onQuote: (ask) => {
 *             const served = validateAsk(ask, POLICY);
 *             return served.ok ? quoted(price(ask)) : served.error;
 *         },
 *         async onAssigned(session) {
 *             // drive the session; see the funding skill for a whole flow
 *         },
 *     },
 *     { state: { version: 1, initial: () => ({ phase: "new" }) } },
 * );
 * ```
 */
export function serveFunding<S>(
    handlers: FundingProviderHandlers<S>,
    options: ServeFundingOptions<S>,
): FundingServer {
    const client = options.client ?? (getClientSync() as FundingClient | null);
    if (!client) throw new HostUnavailableError("serveFunding: TruAPI unavailable");
    const timing: FundingTiming = { ...DEFAULT_FUNDING_TIMING, ...options.timing };
    const log = options.logger ?? createLogger("funding-provider");
    const running = new Map<string, Running<S>>();
    const restarts = new Map<string, number>();
    let subscription: { unsubscribe(): void } | undefined;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    let reopenAt = Number.POSITIVE_INFINITY;
    let stopped = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });

    const open = () => {
        if (stopped) return;
        subscription?.unsubscribe();
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            reopen(timing.resubscribeMs);
        };
        subscription = client.fundingProvider.serveSubscribe().subscribe({
            next: (item) => handle(item),
            error: (reason) => {
                log.warn("serve stream failed", { reason });
                close();
            },
            complete: close,
        });
    };

    /** Reopen the stream after `delayMs`, unless a sooner reopen is already due. */
    const reopen = (delayMs: number) => {
        if (stopped) return;
        const at = Date.now() + delayMs;
        if (reopenTimer !== undefined && reopenAt <= at) return;
        if (reopenTimer !== undefined) clearTimeout(reopenTimer);
        reopenAt = at;
        reopenTimer = setTimeout(() => {
            reopenTimer = undefined;
            reopenAt = Number.POSITIVE_INFINITY;
            open();
        }, delayMs);
    };

    const handle = (item: HostFundingServeSubscribeItem) => {
        if (item.tag === "Assigned") start(item.value.session);
        else if (item.tag === "Cancel") cancel(item.value.intent);
        else void answer(item.value.askId, item.value.ask);
    };

    const start = (assignment: FundingAssignment) => {
        if (stopped || running.has(assignment.intent)) return;
        const controller = new AbortController();
        const session = new FundingSession<S>({
            client,
            assignment,
            spec: options.state,
            timing,
            logger: log,
            signal: controller.signal,
        });
        const entry: Running<S> = { session, controller, cancelRequested: false };
        running.set(assignment.intent, entry);
        void run(entry);
    };

    const run = async (entry: Running<S>) => {
        const { session } = entry;
        try {
            await handlers.onAssigned(session);
            await end(entry);
        } catch (error) {
            await settle(entry, error);
        }
    };

    const end = async (entry: Running<S>) => {
        running.delete(entry.session.intent);
        restarts.delete(entry.session.intent);
        await entry.session.runEndHooks();
    };

    const settle = async (entry: Running<S>, error: unknown) => {
        const { session } = entry;
        if (stopped) {
            running.delete(session.intent);
            return;
        }
        try {
            if (error instanceof SessionOverError) return await end(entry);
            if (error instanceof FundingFailed) {
                const outcome = await session.reportFailure(error.reason);
                if (outcome === "funds-moving") {
                    log.info("funds are moving; the host settles the session", {
                        intent: session.intent,
                    });
                }
                return await end(entry);
            }
            if (
                entry.cancelRequested &&
                (error instanceof FundingAbortedError || entry.controller.signal.aborted)
            ) {
                await session.reportFailure({ tag: "Cancelled" });
                return await end(entry);
            }
        } catch (reportError) {
            if (reportError instanceof SessionOverError) return await end(entry);
            return restart(entry, reportError);
        }
        restart(entry, error);
    };

    /** Drop a session that stopped, and hand it out again after a doubling wait. */
    const restart = (entry: Running<S>, error: unknown) => {
        const { session } = entry;
        log.warn("session stopped; it is handed out again", { intent: session.intent, error });
        running.delete(session.intent);
        const attempt = (restarts.get(session.intent) ?? 0) + 1;
        restarts.set(session.intent, attempt);
        reopen(Math.min(timing.restartBaseMs * 2 ** (attempt - 1), timing.restartMaxMs));
    };

    const cancel = (intent: string) => {
        const entry = running.get(intent);
        if (!entry) return;
        const stop = handlers.onCancel
            ? handlers.onCancel(entry.session)
            : entry.session.cancellable;
        if (!stop) {
            log.info("cancel declined: funds are moving", { intent });
            return;
        }
        entry.cancelRequested = true;
        entry.controller.abort();
    };

    const answer = async (askId: string, ask: FundingQuoteAsk) => {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), timing.quoteDeadlineMs);
        let reply: FundingQuoteAnswer;
        try {
            reply = await Promise.race([
                Promise.resolve(handlers.onQuote(ask, { askId, signal: controller.signal })),
                new Promise<FundingQuoteAnswer>((resolve) =>
                    controller.signal.addEventListener(
                        "abort",
                        () => resolve(refuse.unavailable()),
                        { once: true },
                    ),
                ),
            ]);
        } catch (error) {
            log.warn("onQuote failed", { askId, error });
            reply = refuse.unavailable();
        } finally {
            clearTimeout(deadline);
        }
        try {
            await call(
                client.fundingProvider.answerQuote({ askId, answer: reply }),
                "fundingProvider.answerQuote",
            );
        } catch (error) {
            if (hostErrorTag(error) === "NotFound")
                log.debug("ask timed out before the answer", { askId });
            else log.warn("answering an ask failed", { askId, error });
        }
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (reopenTimer !== undefined) clearTimeout(reopenTimer);
        subscription?.unsubscribe();
        for (const entry of running.values()) entry.controller.abort();
        running.clear();
        resolveDone();
    };
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });

    open();
    return {
        done,
        get running() {
            return new Set(running.keys());
        },
    };
}
