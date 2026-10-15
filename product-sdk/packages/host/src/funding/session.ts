// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * One funding session as a provider's worker runs it: its saved state, its
 * reports, the funds it moves and the screens it shows.
 *
 * Funds only move through journaled steps. `topUp`, `request` and `action`
 * write their step to the journal and save it with the host before they call
 * out, so a worker that restarts finds every top-up, payment request and
 * external order again under the same id instead of starting a second one.
 *
 * @module
 */
import type {
    FundingAssignment,
    FundingDeposit,
    FundingDirection,
    FundingFailure,
    FundingFrameOutcome,
    FundingFrameTarget,
    FundingPayout,
    FundingQuote,
    FundingUpdate,
    HexString,
    HostPaymentStatusSubscribeItem,
    HostPaymentTopUpStatusSubscribeItem,
    PaymentTopUpSource,
} from "@parity/truapi";
import type { Logger } from "@parity/product-sdk-logger";

import { type FundingClient, call } from "./client.js";
import { type EntropyAccount, deriveEntropyAccount } from "./accounts.js";
import {
    FundingAbortedError,
    FundingFailed,
    PaymentRefusedError,
    ReportRefusedError,
    SessionOverError,
    StateTooLargeError,
    TopUpRefusedError,
    hostErrorTag,
} from "./errors.js";
import { deriveId } from "./ids.js";
import { coreHas, isAfterRelease, updateRank } from "./order.js";
import {
    type Journal,
    type JournalEntry,
    MAX_SAVED_BYTES,
    type SavedStateSpec,
    decodeEnvelope,
    encodeEnvelope,
} from "./state.js";
import { retry, sleep, waitUntil } from "./time.js";

/** How long a session waits and how often it retries. */
export interface FundingTiming {
    /** Reopen the serve stream after it ends or fails. Default 5 s. */
    resubscribeMs: number;
    /** First wait before a crashed session is handed out again, doubling. Default 5 s. */
    restartBaseMs: number;
    /** Longest wait before a crashed session is handed out again. Default 10 min. */
    restartMaxMs: number;
    /** First wait between tries of a report, save or call. Default 1 s. */
    retryBaseMs: number;
    /** Longest wait between tries. Default 30 s. */
    retryMaxMs: number;
    /** Tries of a report, save or call before the session restarts. Default 8. */
    retryAttempts: number;
    /**
     * Tries of a payout report the core refuses until it has released the
     * withdrawal, which follows the payment completing. Default 10.
     */
    afterReleaseAttempts: number;
    /** Time `onQuote` has to answer; the host gives up at 10 s. Default 9 s. */
    quoteDeadlineMs: number;
}

/** The timing a session uses when none is given. */
export const DEFAULT_FUNDING_TIMING: FundingTiming = {
    resubscribeMs: 5_000,
    restartBaseMs: 5_000,
    restartMaxMs: 10 * 60_000,
    retryBaseMs: 1_000,
    retryMaxMs: 30_000,
    retryAttempts: 8,
    afterReleaseAttempts: 10,
    quoteDeadlineMs: 9_000,
};

/**
 * What a report came to:
 * - `"stored"`: the host took it;
 * - `"already"`: the core already has it, from before a restart;
 * - `"funds-moving"`: a `Failed` the core refused because funds are moving,
 *   so the top-ups or payment decide the outcome instead.
 */
export type ReportOutcome = "stored" | "already" | "funds-moving";

/** How a top-up ended. */
export type TopUpOutcome =
    | { tag: "Claimed" }
    | { tag: "ClaimedPartially"; actualClaimed: bigint }
    | { tag: "NotClaimed" };

/** How a payment ended. */
export type PaymentOutcome =
    | { tag: "Completed" }
    | { tag: "ClaimedPartially"; actualClaimed: bigint }
    | { tag: "Failed"; reason: string };

/** How an external page closed. */
export type PageResult =
    | { tag: "Returned"; url: URL; params: URLSearchParams }
    | { tag: "Dismissed" }
    | { tag: "Closed" };

/** A failure reason, or the tag of one that carries no data. */
export type FailureCode = Exclude<FundingFailure, { tag: "Other" }>["tag"];

/** Top-ups the core takes for one session. */
const TOP_UP_LIMIT = 3;

/** Check `url` is https with a host and no credentials, as the host requires. */
function checkHttps(url: string, what: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new TypeError(`${what} is not a URL: ${url}`);
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
        throw new TypeError(`${what} must be https with a host and no credentials: ${url}`);
    }
    return parsed;
}

/**
 * Follow a host status stream until `final` picks a value. A stream that
 * ends or fails, or an id the host does not know yet, is followed again after
 * a doubling wait, as the RFC asks of undecided statuses.
 */
async function follow<Item, R>(
    open: () => {
        subscribe(observer: {
            next?: (item: Item) => void;
            error?: (reason: unknown) => void;
            complete?: () => void;
        }): { unsubscribe(): void };
    },
    final: (item: Item) => R | undefined,
    signal: AbortSignal,
    timing: FundingTiming,
): Promise<R> {
    let delay = timing.retryBaseMs;
    for (;;) {
        const outcome = await new Promise<{ value: R } | undefined>((resolve, reject) => {
            if (signal.aborted) return reject(new FundingAbortedError("following a status"));
            let settled = false;
            const finish = (value: { value: R } | undefined) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                queueMicrotask(() => subscription.unsubscribe());
                resolve(value);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                subscription.unsubscribe();
                reject(new FundingAbortedError("following a status"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            const subscription = open().subscribe({
                next: (item) => {
                    const value = final(item);
                    if (value !== undefined) finish({ value });
                },
                error: () => finish(undefined),
                complete: () => finish(undefined),
            });
        });
        if (outcome) return outcome.value;
        await sleep(delay, signal);
        delay = Math.min(delay * 2, timing.retryMaxMs);
    }
}

/** What a session needs from the server that runs it. */
export interface SessionContext<S> {
    client: FundingClient;
    assignment: FundingAssignment;
    spec: SavedStateSpec<S>;
    timing: FundingTiming;
    logger: Logger;
    /** Aborts the session: a cancel the provider honoured, or the server stopping. */
    signal: AbortSignal;
}

/**
 * A funding session the provider's worker runs, handed to `onAssigned`.
 *
 * Read the provider's state from {@link state}, change it with
 * {@link checkpoint}, report with the update helpers, and move funds only
 * through {@link credit}, {@link collect}, {@link refund} (or the lower-level
 * {@link topUp} and {@link request}), and {@link action} for anything external.
 */
export class FundingSession<S> {
    readonly intent: string;
    readonly direction: FundingDirection;
    /** The amount asked for, in balance units; undefined when the user picks it on the provider's screens. */
    readonly amount: bigint | undefined;
    /** The quote the user chose, if any. */
    readonly quote: FundingQuote | undefined;
    /** Unix ms the session expires at unless the provider reports, if it does. */
    readonly expiresAt: bigint | undefined;
    /** Whether the host handed back state this provider saved (a restart). */
    readonly resumed: boolean;
    /** Aborted when a cancel is honoured or serving stops. Pass it to every wait. */
    readonly signal: AbortSignal;

    readonly #client: FundingClient;
    readonly #spec: SavedStateSpec<S>;
    readonly #timing: FundingTiming;
    readonly #log: Logger;
    #state: S;
    #journal: Journal;
    #lastStep: FundingUpdate | undefined;
    #received = false;
    readonly #onEnd = new Set<() => Promise<void> | void>();
    readonly #accounts = new Map<string, Promise<EntropyAccount>>();

    constructor(context: SessionContext<S>) {
        const { assignment } = context;
        this.intent = assignment.intent;
        this.direction = assignment.direction;
        this.amount = assignment.amount;
        this.quote = assignment.quote;
        this.expiresAt = assignment.expiresAt;
        this.signal = context.signal;
        this.#client = context.client;
        this.#spec = context.spec;
        this.#timing = context.timing;
        this.#log = context.logger;
        const restored = decodeEnvelope(assignment, context.spec);
        this.#state = restored.state;
        this.#journal = restored.journal;
        this.resumed = restored.resumed;
        this.#lastStep = assignment.lastUpdate;
        const rank = assignment.lastUpdate ? updateRank(assignment.lastUpdate) : undefined;
        this.#received = rank !== undefined && rank >= 1;
    }

    /** The provider's state as last checkpointed, or its initial state. Change it through {@link checkpoint}. */
    get state(): Readonly<S> {
        return this.#state;
    }

    /** The core's last ranked step: what it held when the session was handed over, then every step reported since. */
    get lastStep(): FundingUpdate | undefined {
        return this.#lastStep;
    }

    /**
     * Whether a cancel can still end the session: no top-up or payment
     * request started, and the provider has not marked the user's payment received.
     */
    get cancellable(): boolean {
        const started = Object.values(this.#journal).some(
            (entry) => entry.kind === "topUp" || entry.kind === "request",
        );
        return !started && !this.#received;
    }

    /** The id for `step` in this session; see {@link deriveId}. */
    deriveId(step: string): HexString {
        return deriveId(this.intent, step);
    }

    /** Run `cleanup` when the session ends, whatever way it ends. */
    onEnd(cleanup: () => Promise<void> | void): void {
        this.#onEnd.add(cleanup);
    }

    /** @internal Run the session's end hooks. */
    async runEndHooks(): Promise<void> {
        for (const cleanup of this.#onEnd) {
            try {
                await cleanup();
            } catch (error) {
                this.#log.warn("session cleanup failed", { intent: this.intent, error });
            }
        }
    }

    // ── state ────────────────────────────────────────────────────────────────

    /**
     * Store `next` with the host, retrying transient failures until it sticks.
     * Only then does {@link state} change. Throws {@link SessionOverError} when
     * the host no longer serves the session, {@link StateTooLargeError} past
     * the host's 4 KiB.
     */
    async checkpoint(next: S | ((current: Readonly<S>) => S)): Promise<void> {
        const state =
            typeof next === "function" ? (next as (current: Readonly<S>) => S)(this.#state) : next;
        await this.#save(state, this.#journal);
        this.#state = state;
    }

    async #save(state: S, journal: Journal): Promise<void> {
        const bytes = encodeEnvelope(this.#spec, state, journal);
        await this.#retry(async () => {
            try {
                await call(
                    this.#client.fundingProvider.save({ intent: this.intent, state: bytes }),
                    "fundingProvider.save",
                );
            } catch (error) {
                const tag = hostErrorTag(error);
                if (tag === "NotFound") throw new SessionOverError(this.intent, { cause: error });
                if (tag === "TooLarge")
                    throw new StateTooLargeError((bytes.length - 2) / 2, MAX_SAVED_BYTES);
                throw error;
            }
        });
    }

    async #journalStart(step: string, entry: JournalEntry): Promise<void> {
        const journal = { ...this.#journal, [step]: entry };
        await this.#save(this.#state, journal);
        this.#journal = journal;
    }

    #retry<T>(
        fn: () => Promise<T>,
        attempts = this.#timing.retryAttempts,
        signal: AbortSignal = this.signal,
    ): Promise<T> {
        return retry(fn, {
            attempts,
            delayMs: this.#timing.retryBaseMs,
            maxDelayMs: this.#timing.retryMaxMs,
            signal,
        });
    }

    // ── reports ──────────────────────────────────────────────────────────────

    /**
     * Report `update`, following the core's rules:
     * - a step the core already holds is not sent again (`"already"`);
     * - transient failures are retried, then thrown so the session restarts;
     * - `NotFound` throws {@link SessionOverError}: the session ended;
     * - `OutOfOrder` on a top-up or payment this session started counts as
     *   already reported, on `Failed` once funds move as `"funds-moving"`, and on
     *   a payout update is retried until the core has released the withdrawal;
     *   any other refusal throws {@link ReportRefusedError}, a provider bug.
     */
    report(update: FundingUpdate): Promise<ReportOutcome> {
        return this.#report(update, this.signal);
    }

    /**
     * @internal Report the session's `Failed` ending. Runs on its own signal,
     * since the session's may be aborted by the cancel it reports.
     */
    reportFailure(reason: FundingFailure): Promise<ReportOutcome> {
        return this.#report({ tag: "Failed", value: { reason } }, new AbortController().signal);
    }

    async #report(update: FundingUpdate, signal: AbortSignal): Promise<ReportOutcome> {
        if (coreHas(this.#lastStep, update, this.direction)) return "already";
        const afterRelease = isAfterRelease(update, this.direction);
        const attempts = afterRelease ? this.#timing.afterReleaseAttempts : 1;
        for (let attempt = 1; ; attempt++) {
            try {
                await this.#retry(
                    () =>
                        call(
                            this.#client.fundingProvider.report({ intent: this.intent, update }),
                            `fundingProvider.report ${update.tag}`,
                        ),
                    this.#timing.retryAttempts,
                    signal,
                );
                this.#noteStored(update);
                return "stored";
            } catch (error) {
                const tag = hostErrorTag(error);
                if (tag === "NotFound") throw new SessionOverError(this.intent, { cause: error });
                if (tag === "NotStarted") throw new ReportRefusedError("NotStarted", update.tag);
                if (tag !== "OutOfOrder") throw error;
                const settled = this.#outOfOrder(update);
                if (settled) return settled;
                if (attempt >= attempts) {
                    if (afterRelease) return "already";
                    throw new ReportRefusedError("OutOfOrder", update.tag);
                }
                await sleep(this.#timing.retryBaseMs, signal);
            }
        }
    }

    /** What an `OutOfOrder` answer means for `update`, or undefined to retry or refuse. */
    #outOfOrder(update: FundingUpdate): ReportOutcome | undefined {
        if (update.tag === "Crediting" || update.tag === "Collecting") {
            const id = update.tag === "Crediting" ? update.value.topUpId : update.value.paymentId;
            const started = Object.values(this.#journal).some((entry) => entry.id === id);
            if (started) {
                this.#noteStored(update);
                return "already";
            }
        }
        if (update.tag === "Failed" && !this.cancellable) return "funds-moving";
        return undefined;
    }

    #noteStored(update: FundingUpdate): void {
        const rank = updateRank(update);
        const last = this.#lastStep === undefined ? undefined : updateRank(this.#lastStep);
        if (rank !== undefined && (last === undefined || rank >= last)) this.#lastStep = update;
        if (update.tag === "PaymentReceived") this.#received = true;
    }

    /** Inbound: waiting for the user to pay the provider. */
    awaitingPayment(): Promise<ReportOutcome> {
        return this.report({ tag: "AwaitingPayment" });
    }

    /** Inbound: the user's payment reached the provider; `finalized` once it cannot be reversed. */
    paymentReceived(received: {
        finalized: boolean;
        mismatch?: { asset: string; amount: bigint };
    }): Promise<ReportOutcome> {
        return this.report({ tag: "PaymentReceived", value: received });
    }

    /** Converting to the user's balance (In), or after a withdrawal is released (Out). */
    converting(): Promise<ReportOutcome> {
        return this.report({ tag: "Converting" });
    }

    /** Inbound: name a top-up this session started. Prefer {@link credit}. */
    crediting(topUpId: HexString, amount: bigint): Promise<ReportOutcome> {
        return this.report({ tag: "Crediting", value: { topUpId, amount } });
    }

    /** Inbound: no more top-ups follow. */
    delivered(): Promise<ReportOutcome> {
        return this.report({ tag: "Delivered" });
    }

    /** Outbound: name a payment request this session started. Prefer {@link collect}. */
    collecting(paymentId: HexString, amount: bigint): Promise<ReportOutcome> {
        return this.report({ tag: "Collecting", value: { paymentId, amount } });
    }

    /** Where and what the user pays, shown by the host until funds move. */
    deposit(deposit: FundingDeposit): Promise<ReportOutcome> {
        return this.report({ tag: "Deposit", value: { deposit } });
    }

    /** The provider's references for the session, shown in the user's history. */
    details(details: { transactionId?: string; reference?: string }): Promise<ReportOutcome> {
        return this.report({ tag: "Details", value: details });
    }

    /** Outbound, once released: the payout to the user's bank, card or wallet. */
    payout(outcome: FundingPayout): Promise<ReportOutcome> {
        return this.report({ tag: "Payout", value: { outcome } });
    }

    /** Outbound, once released: the payout is being retried. */
    payoutRetrying(): Promise<ReportOutcome> {
        return this.report({ tag: "PayoutRetrying" });
    }

    /** Outbound, after a failed payout: name the top-up refunding the user. Prefer {@link refund}. */
    refunding(topUpId: HexString, amount: bigint): Promise<ReportOutcome> {
        return this.report({ tag: "Refunding", value: { topUpId, amount } });
    }

    /** End the session as `Failed`. `serveFunding` reports it when the session unwinds. */
    fail(reason: FundingFailure | FailureCode): never {
        throw new FundingFailed(
            typeof reason === "string" ? ({ tag: reason } as FundingFailure) : reason,
        );
    }

    // ── funds ────────────────────────────────────────────────────────────────

    /**
     * Start, or find again, the top-up for `step`: journal it, save, then ask
     * the host. `AlreadyExists` means it started before a restart, so it
     * resolves with `resumed: true`. Throws {@link TopUpRefusedError} for a
     * malformed source or a zero amount.
     */
    async topUp(
        step: string,
        topUp: { amount: bigint; source: PaymentTopUpSource; into?: number },
    ): Promise<{ id: HexString; resumed: boolean }> {
        const id = await this.#start(step, "topUp", topUp.amount);
        try {
            await this.#retry(() =>
                call(
                    this.#client.payment.topUp({
                        id,
                        amount: topUp.amount,
                        source: topUp.source,
                        into: topUp.into,
                    }),
                    "payment.topUp",
                ),
            );
            return { id, resumed: false };
        } catch (error) {
            const tag = hostErrorTag(error);
            if (tag === "AlreadyExists") return { id, resumed: true };
            if (tag === "InvalidSource" || tag === "InvalidAmount")
                throw new TopUpRefusedError(tag);
            throw error;
        }
    }

    /** Follow a top-up to `Claimed { finalized: true }`, `ClaimedPartially` or `NotClaimed`. */
    followTopUp(id: HexString): Promise<TopUpOutcome> {
        return follow<HostPaymentTopUpStatusSubscribeItem, TopUpOutcome>(
            () => this.#client.payment.topUpStatusSubscribe({ request: { id } }),
            (status) => {
                if (status.tag === "Claimed")
                    return status.value.finalized ? { tag: "Claimed" } : undefined;
                if (status.tag === "ClaimedPartially") {
                    return { tag: "ClaimedPartially", actualClaimed: status.value.actualClaimed };
                }
                if (status.tag === "NotClaimed") return { tag: "NotClaimed" };
                return undefined;
            },
            this.signal,
            this.#timing,
        );
    }

    /**
     * Credit the user: start the top-up for `step` (such as `"topup/0"`), name
     * it in a `Crediting` report, and follow it until it is final. The core
     * takes up to three top-ups per session.
     */
    async credit(
        step: string,
        topUp: { amount: bigint; source: PaymentTopUpSource },
    ): Promise<TopUpOutcome> {
        const credits = Object.values(this.#journal).filter((entry) => entry.kind === "topUp");
        if (!this.#journal[step] && credits.length >= TOP_UP_LIMIT) {
            throw new RangeError(`the core takes at most ${TOP_UP_LIMIT} top-ups per session`);
        }
        const { id } = await this.topUp(step, topUp);
        await this.crediting(id, topUp.amount);
        return this.followTopUp(id);
    }

    /**
     * Refund a withdrawal whose payout failed: start the top-up for `step`
     * (`"refund"` by convention), name it in a `Refunding` report, and follow it.
     */
    async refund(
        step: string,
        topUp: { amount: bigint; source: PaymentTopUpSource },
    ): Promise<TopUpOutcome> {
        const { id } = await this.topUp(step, topUp);
        await this.refunding(id, topUp.amount);
        return this.followTopUp(id);
    }

    /**
     * Ask the user to approve a payment for `step`: journal it, save, then ask
     * the host. `AlreadyExists` resolves with `resumed: true`. Throws
     * {@link PaymentRefusedError} when the user rejects it or cannot cover it.
     */
    async request(
        step: string,
        payment: { amount: bigint; destination: HexString; from?: number },
    ): Promise<{ id: HexString; resumed: boolean }> {
        const id = await this.#start(step, "request", payment.amount);
        try {
            await this.#retry(() =>
                call(
                    this.#client.payment.request({
                        id,
                        amount: payment.amount,
                        destination: payment.destination,
                        from: payment.from,
                    }),
                    "payment.request",
                ),
            );
            return { id, resumed: false };
        } catch (error) {
            const tag = hostErrorTag(error);
            if (tag === "AlreadyExists") return { id, resumed: true };
            if (tag === "Rejected" || tag === "InsufficientBalance" || tag === "InvalidAmount") {
                throw new PaymentRefusedError(tag);
            }
            throw error;
        }
    }

    /** Follow a payment to `Completed`, `ClaimedPartially` or `Failed`. */
    followPayment(id: HexString): Promise<PaymentOutcome> {
        return follow<HostPaymentStatusSubscribeItem, PaymentOutcome>(
            () => this.#client.payment.statusSubscribe({ request: { id } }),
            (status) => {
                if (status.tag === "Completed") return { tag: "Completed" };
                if (status.tag === "ClaimedPartially") {
                    return { tag: "ClaimedPartially", actualClaimed: status.value.actualClaimed };
                }
                if (status.tag === "Failed") return { tag: "Failed", reason: status.value.reason };
                return undefined;
            },
            this.signal,
            this.#timing,
        );
    }

    /**
     * Collect from the user: request the payment for `step` (`"payment"` by
     * convention), name it in a `Collecting` report, and follow it. A payment
     * that completed at once may have released the session before the report,
     * which is fine.
     */
    async collect(
        step: string,
        payment: { amount: bigint; destination: HexString },
    ): Promise<PaymentOutcome> {
        const { id } = await this.request(step, payment);
        try {
            await this.collecting(id, payment.amount);
        } catch (error) {
            if (!(error instanceof SessionOverError)) throw error;
        }
        return this.followPayment(id);
    }

    /**
     * Run an external, idempotent action for `step`, such as creating an
     * onramp order, keyed by the step's id. The step is journaled and saved
     * before `run` starts; after a restart, a step that started but did not
     * finish runs again with the same id (so the provider's API must treat it
     * as its idempotency key), and a finished one returns its saved result
     * without running. The result must be small and JSON-serializable.
     */
    async action<R>(step: string, run: (id: HexString) => Promise<R>): Promise<R> {
        const entry = this.#journal[step];
        if (entry?.done) return entry.result as R;
        const id = await this.#start(step, "action");
        const result = await run(id);
        const journal: Journal = {
            ...this.#journal,
            [step]: { ...(this.#journal[step] as JournalEntry), done: true, result },
        };
        await this.#save(this.#state, journal);
        this.#journal = journal;
        return result;
    }

    /** Journal `step` and save it, or find it again; returns its id. */
    async #start(step: string, kind: JournalEntry["kind"], amount?: bigint): Promise<HexString> {
        const existing = this.#journal[step];
        if (existing) {
            if (existing.kind !== kind || existing.amount !== amount) {
                throw new TypeError(
                    `step ${step} was started as a ${existing.kind} of ${existing.amount}; it cannot become a ${kind} of ${amount}`,
                );
            }
            return existing.id;
        }
        const entry: JournalEntry = { kind, id: this.deriveId(step), at: Date.now() };
        if (amount !== undefined) entry.amount = amount;
        await this.#journalStart(step, entry);
        return entry.id;
    }

    /** Keep the worker alive while `fn` runs, such as during a payout. */
    async holdWorker<T>(label: string, fn: () => Promise<T>): Promise<T> {
        let operation: number | undefined;
        try {
            operation = (
                await call(this.#client.worker.beginOperation({ label }), "worker.beginOperation")
            ).id;
        } catch (error) {
            this.#log.warn("could not hold the worker", { intent: this.intent, error });
        }
        try {
            return await fn();
        } finally {
            if (operation !== undefined) {
                await call(
                    this.#client.worker.endOperation({ id: operation }),
                    "worker.endOperation",
                ).catch((error: unknown) =>
                    this.#log.warn("could not release the worker", { error }),
                );
            }
        }
    }

    /** Wait until Unix ms `at`. Save `at` before waiting, so a restart waits only the rest. */
    waitUntil(at: number): Promise<void> {
        return waitUntil(at, this.signal);
    }

    // ── screens ──────────────────────────────────────────────────────────────

    /** Show one of the provider's frames and resolve with how it closed. */
    async presentFrame(target: FundingFrameTarget): Promise<FundingFrameOutcome> {
        try {
            const response = await this.#retry(() =>
                call(
                    this.#client.fundingProvider.presentFrame({ intent: this.intent, target }),
                    "fundingProvider.presentFrame",
                ),
            );
            return response.outcome;
        } catch (error) {
            if (hostErrorTag(error) === "NotFound")
                throw new SessionOverError(this.intent, { cause: error });
            throw error;
        }
    }

    /** Show a route of the provider's App, with `intent` added to its query. */
    presentApp(route: string, query: Record<string, string> = {}): Promise<FundingFrameOutcome> {
        const [path, existing = ""] = route.split("?", 2);
        const params = new URLSearchParams(existing);
        for (const [key, value] of Object.entries(query)) params.set(key, value);
        params.set("intent", this.intent);
        return this.presentFrame({ tag: "App", value: { route: `${path}?${params}` } });
    }

    /**
     * Show an external https page, such as an onramp's widget. When it
     * navigates to `returnUrl` the host closes it and the result carries the
     * URL it reached, with its query parsed.
     */
    async presentPage(url: string, returnUrl?: string): Promise<PageResult> {
        checkHttps(url, "page url");
        if (returnUrl !== undefined) checkHttps(returnUrl, "return url");
        const outcome = await this.presentFrame({ tag: "Page", value: { url, returnUrl } });
        if (outcome.tag !== "Returned") return { tag: outcome.tag };
        const reached = new URL(outcome.value.url);
        return { tag: "Returned", url: reached, params: reached.searchParams };
    }

    // ── accounts ─────────────────────────────────────────────────────────────

    /**
     * The account for `label` derived from host entropy, `"session/<intent>"`
     * by default. The same after a restart.
     */
    account(label = `session/${this.intent}`): Promise<EntropyAccount> {
        let account = this.#accounts.get(label);
        if (!account) {
            account = deriveEntropyAccount(this.#client, label);
            this.#accounts.set(label, account);
            account.catch(() => this.#accounts.delete(label));
        }
        return account;
    }
}
