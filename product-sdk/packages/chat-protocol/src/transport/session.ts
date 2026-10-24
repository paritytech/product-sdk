// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { bytesEqual, toHex } from "../bytes.js";
import { requestChannel, responseChannel } from "../crypto/derivations.js";
import type {
    Clock,
    IdSource,
    Logger,
    StatementProver,
    StatementsPort,
    Unsubscribe,
} from "../ports.js";
import type { Statement } from "../wire/statement.js";
import type { IncomingFrame, SessionLane } from "./lanes.js";
import {
    type CompactedBatch,
    type IncomingRequest,
    type InitialData,
    initialSession,
    type OutgoingRequest,
    type SessionEffect,
    type SessionEvent,
    type SessionState,
    transition,
} from "./sessionState.js";
import {
    fetchStatements,
    proveAndSubmit,
    type TopicSubscriptions,
    type VerifiedStatement,
} from "./statements.js";

/** What a session reports to the chat layer. Each callback receives encoded chat messages. */
export interface SessionListener {
    /** New messages from the peer (one acknowledged request). */
    onMessagesReceived(requestId: string, messages: Uint8Array[]): void | Promise<void>;
    /** The store accepted a request carrying these messages (status `IS_SENT`). */
    onMessagesSent(messages: Uint8Array[]): void;
    /** A peer device acknowledged these messages (status `IS_READ`, shown as delivered). */
    onMessagesDelivered(messages: Uint8Array[]): void;
    /** Submitting a request failed; the session re-initialises. */
    onMessagesFailedToSend(messages: Uint8Array[]): void;
    /** A message exceeds the request budget and cannot be compacted. */
    onMessageTooLarge(message: Uint8Array): void;
    /** Our stored request is gone (expired or replaced): previously sent messages must be queued again. */
    onSentMessagesNotFound(): void;
    /** Compaction replaced `originals` with `commit`. */
    onMessagesCompacted(batch: CompactedBatch): void;
}

/** Packs messages into compaction commits (HOP inline entries). */
export interface Compactor {
    compact(messages: Uint8Array[]): Promise<CompactedBatch[]>;
}

/** Dependencies of a communication session. */
export interface SessionDeps {
    /** Who the session's topics belong to, for wake watches: the contact id. */
    owner?: string;
    statements: StatementsPort;
    subscriptions: TopicSubscriptions;
    prover: StatementProver;
    clock: Clock;
    ids: IdSource;
    logger: Logger;
    lane: SessionLane;
    maxStatementBytes: number;
    compactor?: Compactor;
    listener: SessionListener;
    /** Delay before retrying a failed initial fetch. */
    refetchDelayMs?: number;
}

/**
 * A contact session (`RealCommunicationSession.kt`): runs the state machine,
 * executes its effects in order, and keeps the transport and the chat layer
 * apart. Events are handled one at a time.
 */
export class CommunicationSession {
    private state: SessionState;
    private queue: Promise<void> = Promise.resolve();
    private polling: Unsubscribe[] = [];
    private stopped = false;

    constructor(private readonly deps: SessionDeps) {
        this.state = initialSession().state;
    }

    /** Current state, for tests and diagnostics. */
    get currentState(): SessionState {
        return this.state;
    }

    /**
     * Starts the session: fetches stored statements, then polls. Messages
     * submitted before the start stay queued in the initialization state.
     */
    start(): Promise<void> {
        return this.enqueue(() => this.run(initialSession().effects));
    }

    /** Queues an encoded chat message for sending. */
    submit(message: Uint8Array): Promise<void> {
        return this.dispatch({ kind: "SubmitMessage", message });
    }

    /** Re-reads the peer's topics, after its device roster changed. */
    refreshTopics(): Promise<void> {
        return this.enqueue(async () => {
            if (this.polling.length === 0 || this.stopped) return;
            this.stopPolling();
            this.startPolling();
        });
    }

    /** Stops polling and drops queued work. */
    stop(): void {
        this.stopped = true;
        this.stopPolling();
    }

    /** Waits until queued events have run. */
    idle(): Promise<void> {
        return this.queue;
    }

    private dispatch(event: SessionEvent): Promise<void> {
        return this.enqueue(() => this.apply(event));
    }

    private enqueue(work: () => Promise<void>): Promise<void> {
        const next = this.queue.then(async () => {
            if (this.stopped) return;
            try {
                await work();
            } catch (error) {
                this.deps.logger.warn(
                    `session work failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        });
        this.queue = next;
        return next;
    }

    private async apply(event: SessionEvent): Promise<void> {
        const step = transition(this.state, event, {
            maxStatementBytes: this.deps.maxStatementBytes,
            canCompact: this.deps.compactor !== undefined,
            nowMs: () => this.deps.clock.nowMs(),
            newRequestId: () => this.deps.ids.next(),
        });
        this.state = step.state;
        await this.run(step.effects);
    }

    private async run(effects: SessionEffect[]): Promise<void> {
        for (const effect of effects) {
            if (this.stopped) return;
            await this.execute(effect);
        }
    }

    private async execute(effect: SessionEffect): Promise<void> {
        const { listener } = this.deps;
        switch (effect.kind) {
            case "FetchInitialData":
                await this.fetchInitialData();
                return;
            case "StartPolling":
                this.startPolling();
                return;
            case "StopPolling":
                this.stopPolling();
                return;
            case "SubmitRequest":
                await this.submitRequest(effect.request);
                return;
            case "SubmitResponse":
                await this.submitFrame(
                    { kind: "Response", response: effect.response },
                    responseChannel(this.deps.lane.outgoingTopic),
                    effect.response.expiry,
                );
                return;
            case "RequestReceived":
                await listener.onMessagesReceived(
                    effect.request.requestId,
                    effect.request.messages,
                );
                return;
            case "ResponseReceived":
                listener.onMessagesDelivered(effect.messages);
                return;
            case "Compact":
                this.compact(effect.messages);
                return;
            case "MessagesCompacted":
                listener.onMessagesCompacted(effect.batch);
                return;
            case "MessageTooLarge":
                listener.onMessageTooLarge(effect.message);
                return;
        }
    }

    private compact(messages: Uint8Array[]): void {
        const compactor = this.deps.compactor;
        if (!compactor) return;
        compactor.compact(messages).then(
            (batches) => this.dispatch({ kind: "CompactionCompleted", batches }),
            () => this.dispatch({ kind: "CompactionFailed" }),
        );
    }

    private async submitRequest(request: OutgoingRequest): Promise<void> {
        const accepted = await this.submitFrame(
            { kind: "Request", request },
            requestChannel(this.deps.lane.outgoingTopic),
            request.expiry,
        );
        if (accepted) {
            this.deps.listener.onMessagesSent(request.messages);
        } else {
            this.deps.listener.onMessagesFailedToSend(request.messages);
            queueMicrotask(() => this.dispatch({ kind: "InvalidateSession" }));
        }
    }

    private async submitFrame(
        frame: Parameters<SessionLane["encode"]>[0],
        channel: Uint8Array,
        expiry: bigint,
    ): Promise<boolean> {
        const { lane, statements, prover, clock, logger } = this.deps;
        const statement: Statement = {
            expiry,
            channel,
            topics: [lane.outgoingTopic],
            data: lane.encode(frame),
        };
        const outcome = await proveAndSubmit(statements, prover, statement, clock);
        if (outcome.kind === "Rejected") {
            logger.warn(`${frame.kind} rejected: ${outcome.reason}`);
            if (frame.kind === "Response")
                queueMicrotask(() => this.dispatch({ kind: "InvalidateSession" }));
            return false;
        }
        return true;
    }

    private async fetchInitialData(): Promise<void> {
        const { lane, statements, clock, prover, listener } = this.deps;
        let own: Statement[];
        let incoming: Statement[];
        try {
            own = await fetchStatements(statements, { matchAll: [lane.outgoingTopic] }, clock);
            const topics = lane.incomingTopics();
            incoming =
                topics.length > 0
                    ? await fetchStatements(statements, { matchAny: topics }, clock)
                    : [];
        } catch (error) {
            this.deps.logger.warn(
                `initial fetch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            clock
                .sleep(this.deps.refetchDelayMs ?? 5_000)
                .then(() => this.enqueue(() => this.fetchInitialData()));
            return;
        }
        const ownFrames = own
            .filter(
                (statement) =>
                    statement.proof?.tag === "Sr25519" &&
                    bytesEqual(statement.proof.value.signer, prover.account),
            )
            .map((statement) => lane.decodeOwn(statement))
            .filter((frame): frame is IncomingFrame => frame !== undefined)
            .sort((left, right) => compareExpiry(frameExpiry(right), frameExpiry(left)));
        const peerFrames = incoming
            .map((statement) => {
                const signer =
                    statement.proof?.tag === "Sr25519" ? statement.proof.value.signer : undefined;
                return signer ? lane.decodePeer(statement, signer) : undefined;
            })
            .filter((frame): frame is IncomingFrame => frame !== undefined)
            .sort((left, right) => compareExpiry(frameExpiry(right), frameExpiry(left)));

        this.deps.logger.debug(
            `session ${(this.deps.owner ?? "-").slice(0, 8)}: out ${toHex(lane.outgoingTopic).slice(0, 12)} own ${ownFrames.length}/${own.length}, in ${lane
                .incomingTopics()
                .map((topic) => toHex(topic).slice(0, 12))
                .join(",")} peer ${peerFrames.length}/${incoming.length}`,
        );
        if (!ownFrames.some((frame) => frame.kind === "Request")) listener.onSentMessagesNotFound();
        const maxOwnExpiry = ownFrames.reduce(
            (max, frame) => (frameExpiry(frame) > max ? frameExpiry(frame) : max),
            0n,
        );
        const lastUsedExpiry = maxOwnExpiry > 0n ? maxOwnExpiry : 0n;
        const ownRequest = ownFrames.find((frame) => frame.kind === "Request");
        const outgoingPending =
            ownRequest?.kind === "Request" &&
            !peerFrames.some(
                (frame) =>
                    frame.kind === "Response" &&
                    frame.response.requestId === ownRequest.request.requestId,
            )
                ? {
                      requestId: ownRequest.request.requestId,
                      expiry: ownRequest.request.expiry,
                      messages: ownRequest.request.messages,
                  }
                : undefined;
        const answered = new Set(
            ownFrames.flatMap((frame) =>
                frame.kind === "Response" ? [frame.response.requestId] : [],
            ),
        );
        const data: InitialData = {
            outgoingPending,
            incoming: peerFrames
                .filter(
                    (frame): frame is { kind: "Request"; request: IncomingRequest } =>
                        frame.kind === "Request",
                )
                .map((frame) => ({
                    request: frame.request,
                    responded: answered.has(frame.request.requestId),
                })),
            lastUsedExpiry,
        };
        await this.apply({ kind: "InitialDataFetched", data });
    }

    private startPolling(): void {
        const { lane, subscriptions } = this.deps;
        for (const topic of lane.incomingTopics()) {
            this.polling.push(
                subscriptions.listen(topic, (delivered) => this.onStatement(delivered)),
            );
        }
    }

    private stopPolling(): void {
        for (const stop of this.polling) stop();
        this.polling = [];
    }

    private onStatement({ statement, signer }: VerifiedStatement): void {
        const frame = this.deps.lane.decodePeer(statement, signer);
        if (!frame) {
            this.deps.logger.debug(
                `session ${(this.deps.owner ?? "-").slice(0, 8)}: a statement it cannot read`,
            );
            return;
        }
        void this.dispatch(
            frame.kind === "Request"
                ? { kind: "RequestReceived", request: frame.request }
                : { kind: "ResponseReceived", response: frame.response },
        );
    }
}

function frameExpiry(frame: IncomingFrame): bigint {
    return frame.kind === "Request" ? frame.request.expiry : frame.response.expiry;
}

function compareExpiry(left: bigint, right: bigint): number {
    return left > right ? 1 : left < right ? -1 : 0;
}
