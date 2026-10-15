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
import {
    type CancelOffer,
    DEFAULT_FUNDING_TIMING,
    FundingSession,
    type FundingTiming,
} from "./session.js";
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
     * The user asked to cancel before money moved (`session.cancellable`).
     * Return whether to stop; the default stops. Stopping aborts
     * `session.signal`, and the session is reported `Failed { Cancelled }`.
     */
    onCancel?(session: FundingSession<S>): boolean;
    /**
     * The user asked to cancel after money moved. Answer with an offer, which
     * the host shows the user, or a refusal. The default refuses. An open
     * offer is made again as it was when the host asks again after a restart.
     * While an offer is open, call `session.untilCancelDecided()` before the
     * step it would undo.
     */
    onCancelRequest?(session: FundingSession<S>): CancelAnswer | Promise<CancelAnswer>;
    /**
     * The user accepted the offer. `onAssigned` is stopped first (its signal
     * aborts), and this runs on a fresh signal; resolve once the cancel is
     * settled. Refund a withdrawal with `session.refund`, at most what the
     * user paid, and end a top-up with `session.fail("Refunded")` once the
     * user's payment is on its way back. The default does the latter for a
     * top-up; a provider that offers to cancel a withdrawal must handle it.
     */
    onCancelAccepted?(session: FundingSession<S>): Promise<void>;
    /** The user declined the offer, or it lapsed. `onAssigned` carries on. */
    onCancelDeclined?(session: FundingSession<S>): void;
}

/** A provider's answer to a cancel after money moved. */
export type CancelAnswer = { offer: CancelOffer } | { refuse: string };

/** What a cancel after money moved is answered with when the provider has no `onCancelRequest`. */
const DEFAULT_REFUSAL = "This payment can no longer be cancelled";

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
    cancelAccepted: boolean;
    /** `onCancelAccepted` is running, so an abort is the server stopping, not the acceptance. */
    settlingCancel: boolean;
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
        switch (item.tag) {
            case "Assigned":
                return start(item.value.session);
            case "Cancel":
                return cancel(item.value.intent);
            case "CancelAccepted":
                return void accepted(item.value.intent);
            case "CancelDeclined":
                return void declined(item.value.intent);
            case "Quote":
                return void answer(item.value.askId, item.value.ask);
        }
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
        const entry: Running<S> = {
            session,
            controller,
            cancelRequested: false,
            cancelAccepted: session.cancel?.state === "accepted",
            settlingCancel: false,
        };
        running.set(assignment.intent, entry);
        void (entry.cancelAccepted ? settleCancel(entry) : run(entry));
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

    /** Settle a cancel the user accepted, on a fresh signal. */
    const settleCancel = async (entry: Running<S>) => {
        const { session } = entry;
        entry.settlingCancel = true;
        entry.controller = new AbortController();
        session.rebind(entry.controller.signal);
        try {
            if (handlers.onCancelAccepted) await handlers.onCancelAccepted(session);
            else if (session.direction === "In") session.fail("Refunded");
            else
                throw new TypeError(
                    "onCancelAccepted must refund a withdrawal it offered to cancel",
                );
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
            if (
                entry.cancelAccepted &&
                !entry.settlingCancel &&
                !(error instanceof FundingFailed) &&
                (error instanceof FundingAbortedError || entry.controller.signal.aborted)
            ) {
                return void (await settleCancel(entry));
            }
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
        if (!entry || entry.cancelAccepted) return;
        const { session } = entry;
        if (!session.cancellable) {
            void answerCancel(entry);
            return;
        }
        if (handlers.onCancel && !handlers.onCancel(session)) {
            log.info("cancel not honoured", { intent });
            return;
        }
        entry.cancelRequested = true;
        entry.controller.abort();
    };

    /** Answer a cancel after money moved: an open offer again, else what `onCancelRequest` says. */
    const answerCancel = async (entry: Running<S>) => {
        const { session } = entry;
        try {
            const open = session.cancel;
            if (
                open?.state === "offered" &&
                (open.expiresAt ?? Number.POSITIVE_INFINITY) > Date.now()
            ) {
                await session.offerCancel(open);
                return;
            }
            const reply: CancelAnswer = handlers.onCancelRequest
                ? await handlers.onCancelRequest(session)
                : { refuse: DEFAULT_REFUSAL };
            if ("refuse" in reply) {
                await session.refuseCancel(reply.refuse);
            } else if (session.direction === "Out" && !handlers.onCancelAccepted) {
                log.error("a withdrawal's cancel offer needs onCancelAccepted; refusing", {
                    intent: session.intent,
                });
                await session.refuseCancel(DEFAULT_REFUSAL);
            } else {
                await session.offerCancel(reply.offer);
            }
        } catch (error) {
            log.warn("answering a cancel failed", { intent: session.intent, error });
        }
    };

    /** The user accepted the offer: save it, then stop `onAssigned` so the cancel is settled. */
    const accepted = async (intent: string) => {
        const entry = running.get(intent);
        if (!entry || entry.cancelAccepted) return;
        entry.cancelAccepted = true;
        try {
            await entry.session.markCancelAccepted();
        } catch (error) {
            // The host hands the acceptance back on the next stream if it did not stick.
            log.warn("saving the accepted cancel failed", { intent, error });
        }
        entry.controller.abort();
    };

    /** The user declined the offer, or it lapsed: `onAssigned` carries on. */
    const declined = async (intent: string) => {
        const entry = running.get(intent);
        if (!entry || entry.cancelAccepted) return;
        try {
            if (await entry.session.markCancelDeclined())
                handlers.onCancelDeclined?.(entry.session);
        } catch (error) {
            log.warn("saving the declined cancel failed", { intent, error });
        }
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
