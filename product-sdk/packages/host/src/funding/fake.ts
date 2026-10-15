// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A fake funding core for testing a provider's worker, exposed through
 * `@parity/product-sdk-host/testing`.
 *
 * It follows the core's own rules for a session: which reports may come
 * next, which funds a report may name, when a withdrawal is released, what a
 * provider may report after that, and when a cancel applies. Unlike the real
 * core it settles at once: an inbound session is delivered as soon as
 * `Delivered` is reported, and a withdrawal is released as soon as its payment
 * is named, each from the status scripts the options set.
 *
 * It can also crash the worker right after the host took one of its calls,
 * which is how {@link resumeAtEveryCheckpoint} checks that a provider resumes
 * from every point without moving funds twice.
 *
 * @module
 */
import type {
    FundingAssignment,
    FundingDirection,
    FundingFailure,
    FundingFrameOutcome,
    FundingFrameTarget,
    FundingQuote,
    FundingQuoteAnswer,
    FundingQuoteAsk,
    FundingUpdate,
    HexString,
    HostFundingServeSubscribeItem,
    HostPaymentStatusSubscribeItem,
    HostPaymentTopUpStatusSubscribeItem,
    Subscription,
} from "@parity/truapi";
import { SubscriptionError } from "@parity/truapi";
import { blake2b256 } from "@parity/product-sdk-crypto";
import { errAsync, okAsync } from "neverthrow";

import { makeObservable } from "../fake-observable.js";
import { createFakeTruApiClient } from "../testing.js";
import { fromHex, toHex } from "../truapi.js";
import type { FundingClient } from "./client.js";
import { updateRank } from "./order.js";
import { serveFunding, type FundingProviderHandlers } from "./serve.js";
import type { FundingTiming } from "./session.js";
import { MAX_SAVED_BYTES, type SavedStateSpec } from "./state.js";

/** Calls the fake records and can crash after. */
export type FakeFundingCall =
    | "save"
    | "report"
    | "presentFrame"
    | "answerQuote"
    | "topUp"
    | "request";

/** Options for {@link createFakeFundingHost}. */
export interface FakeFundingHostOptions {
    /** Statuses a top-up goes through. Default `Detecting`, `Claiming`, `Claimed { finalized: true }`. */
    topUpStatus?: (id: HexString) => HostPaymentTopUpStatusSubscribeItem[];
    /** Statuses a payment goes through. Default `Processing`, `Completed`. */
    paymentStatus?: (id: HexString) => HostPaymentStatusSubscribeItem[];
    /** How each frame closes. Default `Closed`. */
    frame?: (target: FundingFrameTarget) => FundingFrameOutcome;
    /** Answer a call with a domain error instead, `times` times (default once). */
    faults?: Array<{
        call: FakeFundingCall;
        answer: string;
        times?: number;
        when?: (request: unknown) => boolean;
    }>;
    /** Crash the worker right after the host took the `index`-th call (from 1) this returns true for. */
    crashAfter?: (call: FakeFundingCall, request: unknown, index: number) => boolean;
    /** Entropy for a context. Default `blake2b-256(context)`. */
    entropy?: (context: HexString) => HexString;
}

/** A session as the fake core holds it. */
export interface FakeFundingSession {
    intent: string;
    direction: FundingDirection;
    amount?: bigint;
    quote?: FundingQuote;
    stage:
        | { tag: "Open" }
        | { tag: "Failed"; reason: FundingFailure }
        | { tag: "Delivered"; credited: bigint }
        | { tag: "Released"; debited: bigint };
    /** Every report stored, in order. */
    updates: FundingUpdate[];
    /** Funds the provider started for the session, and whether a report named them. */
    started: Array<{ id: HexString; amount: bigint; named: boolean }>;
    saved?: HexString;
    refund?: { id: HexString; amount: bigint; refunded?: bigint };
    cancelRequested: boolean;
}

/** One call the worker made and how the fake answered. */
export interface FakeFundingLogEntry {
    call: FakeFundingCall;
    request: unknown;
    /** `"ok"`, or the error tag it was answered with. */
    answer: string;
}

/** A fake funding core. */
export interface FakeFundingHost {
    /**
     * A fresh connection for a worker. A crash ends every earlier one: their
     * calls are refused and their streams end.
     */
    connect(): FundingClient;
    /** Assign a session to the provider, as when the user chooses it; returns the intent. */
    assign(session: {
        direction: FundingDirection;
        intent?: string;
        amount?: bigint;
        quote?: FundingQuote;
    }): string;
    /** Ask the provider for a quote; resolves with its answer, or `"timeout"` after `timeoutMs`. */
    ask(ask: FundingQuoteAsk, timeoutMs?: number): Promise<FundingQuoteAnswer | "timeout">;
    /** Cancel at the user's request, under the core's rules. */
    cancel(intent: string): "Refused" | "Requested" | "Ended";
    /** The session as the core holds it now. */
    session(intent: string): FakeFundingSession | undefined;
    /** Resolve once the provider has no more work on the session, or throw after `timeoutMs`. */
    settled(intent: string, timeoutMs?: number): Promise<FakeFundingSession>;
    /** End the worker's connection now, as a crash or kill would. */
    crash(): void;
    /** Run `fn` when the fake crashes the worker. */
    onCrash(fn: () => void): void;
    /** Every call the workers made, in order. */
    readonly log: ReadonlyArray<FakeFundingLogEntry>;
    /** Top-ups and payment requests the host took, by id. */
    readonly funds: ReadonlyMap<HexString, { kind: "topUp" | "request"; amount: bigint }>;
}

const domainError = (tag: string, value?: unknown) =>
    errAsync({
        tag: "Domain",
        value: { tag: "V1", value: value === undefined ? { tag } : { tag, value } },
    } as never);

type Rejection = "NotFound" | "OutOfOrder" | "NotStarted";

/** The core's rules for one session. */
class Core {
    constructor(readonly session: FakeFundingSession) {}

    get terminal(): boolean {
        return this.session.stage.tag !== "Open";
    }

    lastStep(): FundingUpdate | undefined {
        return [...this.session.updates]
            .reverse()
            .find((update) => updateRank(update) !== undefined);
    }

    fundsMoving(): boolean {
        return this.session.updates.some((u) => u.tag === "Crediting" || u.tag === "Collecting");
    }

    holdsPayment(): boolean {
        return this.fundsMoving() || this.session.updates.some((u) => u.tag === "PaymentReceived");
    }

    payout(): FundingUpdate | undefined {
        return this.session.updates.find((u) => u.tag === "Payout");
    }

    awaitsRefund(): boolean {
        const payout = this.payout();
        return (
            this.session.stage.tag === "Released" &&
            payout?.tag === "Payout" &&
            payout.value.outcome.tag === "Failed" &&
            this.session.refund === undefined
        );
    }

    awaitsProvider(): boolean {
        if (this.session.stage.tag !== "Released") return false;
        const payout = this.payout();
        if (payout?.tag !== "Payout") return true;
        if (payout.value.outcome.tag === "PaidOut") return false;
        return this.session.refund?.refunded === undefined;
    }

    servesProvider(): boolean {
        return !this.terminal || this.awaitsProvider();
    }

    follows(update: FundingUpdate): boolean {
        const { direction } = this.session;
        const fits =
            update.tag === "Collecting"
                ? direction === "Out"
                : update.tag === "Failed" || update.tag === "Details"
                  ? true
                  : direction === "In";
        if (!fits) return false;
        const last = (() => {
            const step = this.lastStep();
            return step ? updateRank(step) : undefined;
        })();
        const rank = updateRank(update);
        const below = (a: number | undefined, b: number | undefined) => (a ?? -1) < (b ?? -1);
        const topUps = this.session.updates.flatMap((u) =>
            u.tag === "Crediting" ? [u.value.topUpId] : [],
        );
        switch (update.tag) {
            case "Details":
                return true;
            case "Failed":
            case "Deposit":
                return !this.fundsMoving();
            case "Crediting":
                return (
                    (last ?? -1) <= (rank ?? -1) &&
                    topUps.length < 3 &&
                    !topUps.includes(update.value.topUpId)
                );
            case "Delivered":
                return below(last, rank) && topUps.length > 0;
            default:
                return below(last, rank);
        }
    }

    /** Store `update`, or the reason the core refuses it. */
    report(update: FundingUpdate): Rejection | undefined {
        const afterRelease =
            update.tag === "Payout" ||
            update.tag === "Refunding" ||
            update.tag === "PayoutRetrying" ||
            (update.tag === "Converting" && this.session.direction === "Out");
        if (afterRelease) {
            if (!this.terminal) return "OutOfOrder";
            if (this.session.stage.tag !== "Released") return "NotFound";
            if (update.tag === "Refunding") {
                if (!this.awaitsRefund()) return "OutOfOrder";
                const record = this.unnamed(update.value.topUpId, update.value.amount);
                if (!record) return "NotStarted";
                record.named = true;
                this.session.refund = { id: update.value.topUpId, amount: update.value.amount };
            } else {
                const converting = this.session.updates.some((u) => u.tag === "Converting");
                if (this.payout() || (update.tag === "Converting" && converting))
                    return "OutOfOrder";
            }
            this.session.updates.push(update);
            return undefined;
        }
        if (this.terminal) return "NotFound";
        if (!this.follows(update)) return "OutOfOrder";
        if (update.tag === "Crediting" || update.tag === "Collecting") {
            const id = update.tag === "Crediting" ? update.value.topUpId : update.value.paymentId;
            const record = this.unnamed(id, update.value.amount);
            if (!record) return "NotStarted";
            record.named = true;
        }
        if (update.tag === "Failed")
            this.session.stage = { tag: "Failed", reason: update.value.reason };
        this.session.updates.push(update);
        if (this.terminal || this.holdsPayment()) this.session.cancelRequested = false;
        return undefined;
    }

    unnamed(id: HexString, amount: bigint) {
        return this.session.started.find((r) => r.id === id && !r.named && r.amount === amount);
    }

    /** Record funds the provider started, unless the session cannot take them. */
    recordStart(id: HexString, amount: bigint): boolean {
        if (
            (this.terminal && !this.awaitsRefund()) ||
            this.session.started.some((r) => r.id === id)
        ) {
            return false;
        }
        this.session.started.push({ id, amount, named: false });
        return true;
    }

    cancel(): "Refused" | "Requested" | "Ended" {
        if (this.terminal || this.holdsPayment()) return "Refused";
        if (this.session.cancelRequested) {
            this.session.stage = { tag: "Failed", reason: { tag: "Cancelled" } };
            return "Ended";
        }
        this.session.cancelRequested = true;
        return "Requested";
    }

    assignment(): FundingAssignment {
        const { intent, direction, amount, quote, saved } = this.session;
        return { intent, direction, amount, quote, saved, lastUpdate: this.lastStep() };
    }
}

/** The final status of a script, or undefined for an empty one. */
const finalOf = <T>(items: T[]): T | undefined => items[items.length - 1];

/**
 * A fake funding core and host for a provider's worker. Connect the worker
 * with `serveFunding(handlers, { client: host.connect(), … })`.
 *
 * @example
 * ```ts
 * import { createFakeFundingHost } from "@parity/product-sdk-host/testing";
 *
 * const host = createFakeFundingHost();
 * const intent = host.assign({ direction: "In", amount: 50n });
 * serveFunding(handlers, { client: host.connect(), state: SPEC });
 * const session = await host.settled(intent);
 * expect(session.stage.tag).toBe("Delivered");
 * ```
 */
export function createFakeFundingHost(options: FakeFundingHostOptions = {}): FakeFundingHost {
    const base = createFakeTruApiClient();
    const sessions = new Map<string, Core>();
    const asks = new Map<
        string,
        { ask: FundingQuoteAsk; resolve: (answer: FundingQuoteAnswer) => void }
    >();
    const funds = new Map<HexString, { kind: "topUp" | "request"; amount: bigint }>();
    const log: FakeFundingLogEntry[] = [];
    const faults = (options.faults ?? []).map((fault) => ({ ...fault, left: fault.times ?? 1 }));
    const crashHandlers = new Set<() => void>();
    const watchers = new Set<() => void>();
    let generation = 0;
    let effects = 0;
    let nextIntent = 0;
    let nextAsk = 0;

    type Push = (item: HostFundingServeSubscribeItem) => void;
    const streams = new Map<Push, { generation: number; end: () => void }>();

    const notify = () => {
        for (const watcher of [...watchers]) watcher();
    };
    const push = (item: HostFundingServeSubscribeItem) => {
        for (const [deliver, stream] of streams)
            if (stream.generation === generation) deliver(item);
    };

    const crash = () => {
        generation += 1;
        for (const [deliver, stream] of [...streams]) {
            streams.delete(deliver);
            stream.end();
        }
        for (const handler of crashHandlers) handler();
    };

    /** Answer a call: a fault if one applies, else run it; log it; crash after it if asked. */
    function answer<T>(
        gen: number,
        call: FakeFundingCall,
        request: unknown,
        run: () => { ok: T } | { error: string; value?: unknown },
    ) {
        if (gen !== generation) return errAsync({ tag: "Denied" } as never);
        const fault = faults.find(
            (f) => f.call === call && f.left > 0 && (f.when?.(request) ?? true),
        );
        if (fault) fault.left -= 1;
        const outcome = fault ? { error: fault.answer } : run();
        log.push({ call, request, answer: "ok" in outcome ? "ok" : outcome.error });
        notify();
        effects += 1;
        if (options.crashAfter?.(call, request, effects)) {
            crash();
            return errAsync({ tag: "Denied" } as never);
        }
        return "ok" in outcome ? okAsync(outcome.ok) : domainError(outcome.error, outcome.value);
    }

    const topUpStatuses = (id: HexString): HostPaymentTopUpStatusSubscribeItem[] =>
        options.topUpStatus?.(id) ?? [
            { tag: "Detecting" },
            { tag: "Claiming" },
            { tag: "Claimed", value: { finalized: true } },
        ];
    const paymentStatuses = (id: HexString): HostPaymentStatusSubscribeItem[] =>
        options.paymentStatus?.(id) ?? [{ tag: "Processing" }, { tag: "Completed" }];

    /** Credited by a top-up's final status. */
    const claimed = (id: HexString, amount: bigint): bigint => {
        const final = finalOf(topUpStatuses(id));
        if (final?.tag === "Claimed") return amount;
        if (final?.tag === "ClaimedPartially") return final.value.actualClaimed;
        return 0n;
    };

    /** Settle what a stored report decides, as the core does once the statuses are final. */
    const settle = (core: Core, update: FundingUpdate) => {
        const session = core.session;
        if (update.tag === "Delivered") {
            const credited = session.started
                .filter((r) => r.named)
                .reduce((sum, r) => sum + claimed(r.id, r.amount), 0n);
            session.stage =
                credited > 0n
                    ? { tag: "Delivered", credited }
                    : {
                          tag: "Failed",
                          reason: {
                              tag: "Other",
                              value: { code: "NotClaimed", message: "nothing was claimed" },
                          },
                      };
        } else if (update.tag === "Collecting") {
            const final = finalOf(paymentStatuses(update.value.paymentId));
            if (final?.tag === "Completed")
                session.stage = { tag: "Released", debited: update.value.amount };
            else if (final?.tag === "ClaimedPartially") {
                session.stage = { tag: "Released", debited: final.value.actualClaimed };
            } else if (final?.tag === "Failed") {
                session.stage = {
                    tag: "Failed",
                    reason: {
                        tag: "Other",
                        value: { code: "PaymentFailed", message: final.value.reason },
                    },
                };
            }
        } else if (update.tag === "Refunding" && session.refund) {
            session.refund.refunded = claimed(update.value.topUpId, update.value.amount);
        }
    };

    /** Record funds on the provider's sessions the way the core does: the one asking for the amount, else each. */
    const recordStart = (direction: FundingDirection, id: HexString, amount: bigint) => {
        const served = [...sessions.values()].filter(
            (core) =>
                (!core.terminal && core.session.direction === direction) ||
                (direction === "In" && core.awaitsRefund()),
        );
        const asks = (core: Core) =>
            core.session.stage.tag === "Released"
                ? core.session.stage.debited
                : (core.session.amount ?? 0n);
        const matching = served.filter((core) => asks(core) === amount);
        for (const core of matching.length === 1 ? matching : served) core.recordStart(id, amount);
    };

    function statusStream<Item>(gen: number, items: Item[] | undefined, notFound: string) {
        return makeObservable<Item, unknown>((observer) => {
            let open = true;
            queueMicrotask(() => {
                if (!open || gen !== generation) return;
                if (items === undefined) {
                    observer?.error?.(
                        new SubscriptionError(notFound, {
                            reason: {
                                tag: "Domain",
                                value: { tag: "V1", value: { tag: notFound } },
                            },
                        }),
                    );
                    return;
                }
                for (const item of items) if (open) observer?.next?.(item);
            });
            return {
                unsubscribe: () => {
                    open = false;
                },
                subscriptionId: "fake-status",
            } satisfies Subscription;
        });
    }

    const host: FakeFundingHost = {
        connect() {
            const gen = generation;
            const client = {
                localStorage: base.localStorage,
                entropy: {
                    derive: ({ context }: { context: HexString }) =>
                        gen !== generation
                            ? errAsync({ tag: "Denied" } as never)
                            : okAsync({
                                  entropy:
                                      options.entropy?.(context) ??
                                      toHex(blake2b256(fromHex(context))),
                              }),
                },
                worker: {
                    beginOperation: () => okAsync({ id: 1 }),
                    endOperation: () => okAsync(undefined),
                },
                fundingProvider: {
                    serveSubscribe: () =>
                        makeObservable<HostFundingServeSubscribeItem, never>((observer) => {
                            const deliver: Push = (item) => observer?.next?.(item);
                            if (gen !== generation) {
                                queueMicrotask(() => observer?.complete?.());
                            } else {
                                streams.set(deliver, {
                                    generation: gen,
                                    end: () => observer?.complete?.(),
                                });
                                queueMicrotask(() => {
                                    if (!streams.has(deliver)) return;
                                    for (const core of sessions.values()) {
                                        if (core.servesProvider()) {
                                            deliver({
                                                tag: "Assigned",
                                                value: { session: core.assignment() },
                                            });
                                        }
                                    }
                                    for (const [askId, pending] of asks) {
                                        deliver({
                                            tag: "Quote",
                                            value: { askId, ask: pending.ask },
                                        });
                                    }
                                });
                            }
                            return {
                                unsubscribe: () => void streams.delete(deliver),
                                subscriptionId: "fake-serve",
                            };
                        }),
                    report: ({ intent, update }: { intent: string; update: FundingUpdate }) =>
                        answer(gen, "report", { intent, update }, () => {
                            const core = sessions.get(intent);
                            if (!core) return { error: "NotFound" };
                            const refused = core.report(update);
                            if (refused) return { error: refused };
                            settle(core, update);
                            return { ok: undefined };
                        }),
                    save: ({ intent, state }: { intent: string; state: HexString }) =>
                        answer(gen, "save", { intent, state }, () => {
                            const core = sessions.get(intent);
                            if (!core?.servesProvider()) return { error: "NotFound" };
                            if ((state.length - 2) / 2 > MAX_SAVED_BYTES) {
                                return { error: "TooLarge", value: { max: MAX_SAVED_BYTES } };
                            }
                            core.session.saved = state;
                            return { ok: undefined };
                        }),
                    presentFrame: ({
                        intent,
                        target,
                    }: { intent: string; target: FundingFrameTarget }) =>
                        answer(gen, "presentFrame", { intent, target }, () => {
                            if (!sessions.get(intent)?.servesProvider())
                                return { error: "NotFound" };
                            return {
                                ok: { outcome: options.frame?.(target) ?? { tag: "Closed" } },
                            };
                        }),
                    answerQuote: ({
                        askId,
                        answer: reply,
                    }: { askId: string; answer: FundingQuoteAnswer }) =>
                        answer(gen, "answerQuote", { askId, answer: reply }, () => {
                            const pending = asks.get(askId);
                            if (!pending) return { error: "NotFound" };
                            asks.delete(askId);
                            pending.resolve(reply);
                            return { ok: undefined };
                        }),
                },
                payment: {
                    topUp: (request: { id: HexString; amount: bigint }) =>
                        answer(gen, "topUp", request, () => {
                            if (funds.has(request.id)) return { error: "AlreadyExists" };
                            if (request.amount === 0n) return { error: "InvalidAmount" };
                            funds.set(request.id, { kind: "topUp", amount: request.amount });
                            recordStart("In", request.id, request.amount);
                            return { ok: undefined };
                        }),
                    request: (request: { id: HexString; amount: bigint }) =>
                        answer(gen, "request", request, () => {
                            if (funds.has(request.id)) return { error: "AlreadyExists" };
                            if (request.amount === 0n) return { error: "InvalidAmount" };
                            funds.set(request.id, { kind: "request", amount: request.amount });
                            recordStart("Out", request.id, request.amount);
                            return { ok: undefined };
                        }),
                    topUpStatusSubscribe: ({ request: { id } }: { request: { id: HexString } }) =>
                        statusStream(
                            gen,
                            funds.get(id)?.kind === "topUp" ? topUpStatuses(id) : undefined,
                            "TopUpNotFound",
                        ),
                    statusSubscribe: ({ request: { id } }: { request: { id: HexString } }) =>
                        statusStream(
                            gen,
                            funds.get(id)?.kind === "request" ? paymentStatuses(id) : undefined,
                            "PaymentNotFound",
                        ),
                    balanceSubscribe: () => statusStream(gen, [], "Unknown"),
                },
            };
            return client as unknown as FundingClient;
        },
        assign(session) {
            nextIntent += 1;
            const intent = session.intent ?? `intent-${nextIntent}`;
            const core = new Core({
                intent,
                direction: session.direction,
                amount: session.amount,
                quote: session.quote,
                stage: { tag: "Open" },
                updates: [],
                started: [],
                cancelRequested: false,
            });
            sessions.set(intent, core);
            push({ tag: "Assigned", value: { session: core.assignment() } });
            return intent;
        },
        ask(ask, timeoutMs = 1_000) {
            nextAsk += 1;
            const askId = `ask-${nextAsk}`;
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    asks.delete(askId);
                    resolve("timeout");
                }, timeoutMs);
                asks.set(askId, {
                    ask,
                    resolve: (reply) => {
                        clearTimeout(timer);
                        resolve(reply);
                    },
                });
                push({ tag: "Quote", value: { askId, ask } });
            });
        },
        cancel(intent) {
            const core = sessions.get(intent);
            if (!core) return "Refused";
            const outcome = core.cancel();
            if (outcome === "Requested") push({ tag: "Cancel", value: { intent } });
            notify();
            return outcome;
        },
        session(intent) {
            const core = sessions.get(intent);
            return core ? structuredClone(core.session) : undefined;
        },
        settled(intent, timeoutMs = 5_000) {
            return new Promise((resolve, reject) => {
                const check = () => {
                    const core = sessions.get(intent);
                    if (core && !core.servesProvider()) {
                        watchers.delete(check);
                        clearTimeout(timer);
                        resolve(structuredClone(core.session));
                    }
                };
                const timer = setTimeout(() => {
                    watchers.delete(check);
                    reject(new Error(`session ${intent} did not settle in ${timeoutMs} ms`));
                }, timeoutMs);
                watchers.add(check);
                check();
            });
        },
        crash,
        onCrash(fn) {
            crashHandlers.add(fn);
        },
        get log() {
            return log;
        },
        get funds() {
            return funds;
        },
    };
    return host;
}

/** Timing that keeps a test fast: every wait and retry in milliseconds. */
export const FAST_FUNDING_TIMING: Partial<FundingTiming> = {
    resubscribeMs: 1,
    restartBaseMs: 1,
    restartMaxMs: 4,
    retryBaseMs: 1,
    retryMaxMs: 4,
    retryAttempts: 8,
    afterReleaseAttempts: 20,
    quoteDeadlineMs: 50,
};

/** What a session should reach, for {@link resumeAtEveryCheckpoint}. */
export interface ResumeExpectation {
    /** The stage the core ends the session in. */
    outcome: "Delivered" | "Released" | "Failed";
    /**
     * The tags of the reports the core stores, in order, leaving out
     * `Details`, `Deposit` and `PayoutRetrying`, which a resumed worker may repeat.
     */
    updates?: FundingUpdate["tag"][];
}

/**
 * Run a session through the provider's handlers once, then once more for
 * every call the worker makes to the host: each time crash the worker right
 * after the host took that call, start a fresh worker on the state the host
 * kept, and check that
 * - the session still reaches `expect.outcome` (and `expect.updates`);
 * - the worker started the same top-ups and payment requests, under the
 *   same ids and amounts, as it did without a crash: a repeat after a
 *   restart is answered `AlreadyExists`, never started under a new id;
 * - no report was refused as `NotStarted`.
 *
 * Throws an `Error` naming the crash point that broke a rule; resolves with
 * the number of crash points it tried.
 */
export async function resumeAtEveryCheckpoint<S>(
    handlers: FundingProviderHandlers<S>,
    spec: SavedStateSpec<S>,
    session: { direction: FundingDirection; amount?: bigint; quote?: FundingQuote },
    expect: ResumeExpectation,
    options: FakeFundingHostOptions & { timing?: Partial<FundingTiming>; timeoutMs?: number } = {},
): Promise<{ crashPoints: number }> {
    const run = async (crashAt: number | undefined) => {
        const host = createFakeFundingHost({
            ...options,
            crashAfter:
                crashAt === undefined ? undefined : (_call, _request, index) => index === crashAt,
        });
        const timing = { ...FAST_FUNDING_TIMING, ...options.timing };
        const workers: AbortController[] = [];
        const startWorker = () => {
            const controller = new AbortController();
            workers.push(controller);
            serveFunding(handlers, {
                client: host.connect(),
                state: spec,
                timing,
                signal: controller.signal,
            });
        };
        host.onCrash(() => {
            for (const worker of workers) worker.abort();
            queueMicrotask(startWorker);
        });
        const intent = host.assign(session);
        startWorker();
        try {
            const settled = await host.settled(intent, options.timeoutMs ?? 5_000);
            return { host, settled };
        } finally {
            for (const worker of workers) worker.abort();
        }
    };

    const fundsOf = (host: FakeFundingHost) =>
        [...host.funds]
            .map(([id, { kind, amount }]) => `${kind}:${id}:${amount}`)
            .sort()
            .join("\n");
    const check = (
        label: string,
        host: FakeFundingHost,
        settled: FakeFundingSession,
        expectedFunds?: string,
    ) => {
        const fail = (message: string): never => {
            throw new Error(`${label}: ${message}`);
        };
        if (settled.stage.tag !== expect.outcome) {
            fail(`ended ${settled.stage.tag}, expected ${expect.outcome}`);
        }
        if (expect.updates) {
            const repeatable = new Set(["Details", "Deposit", "PayoutRetrying"]);
            const tags = settled.updates.map((u) => u.tag).filter((tag) => !repeatable.has(tag));
            if (tags.join() !== expect.updates.join()) {
                fail(`stored ${tags.join(", ")}, expected ${expect.updates.join(", ")}`);
            }
        }
        const started = fundsOf(host);
        if (expectedFunds !== undefined && started !== expectedFunds) {
            fail(`started funds\n${started}\nexpected\n${expectedFunds}`);
        }
        const refused = host.log.find((entry) => entry.answer === "NotStarted");
        if (refused)
            fail(`a report was refused NotStarted: ${JSON.stringify(refused.request, bigints)}`);
    };

    const reference = await run(undefined);
    check("without a crash", reference.host, reference.settled);
    const expectedFunds = fundsOf(reference.host);
    const crashPoints = reference.host.log.length;
    for (let point = 1; point <= crashPoints; point++) {
        const { host, settled } = await run(point);
        check(`crashing after call ${point}`, host, settled, expectedFunds);
    }
    return { crashPoints };
}

function bigints(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value;
}
