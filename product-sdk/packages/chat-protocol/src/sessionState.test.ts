// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Port of Android `ActiveStateTest.kt` (feature/statement-store/impl/src/test/.../stateMachine).
import { describe, expect, test } from "vitest";

import {
    type CompactedBatch,
    type OutgoingRequest,
    type SessionContext,
    type SessionEffect,
    type SessionEvent,
    type SessionState,
    transition,
} from "./index.js";

// maxRequestSize = MAX_STATEMENT_SIZE - 168 bytes of statement overhead = 100 bytes
const MAX_STATEMENT_SIZE = 168 + 100;

function context(canCompact = true): SessionContext {
    let counter = 0;
    return {
        maxStatementBytes: MAX_STATEMENT_SIZE,
        canCompact,
        nowMs: () => 0,
        newRequestId: () => `generated-${++counter}`,
    };
}

const message = (size: number, fill: number) => new Uint8Array(size).fill(fill);

const request = (messages: Uint8Array[], requestId = "request-1"): OutgoingRequest => ({
    requestId,
    expiry: 10n,
    messages,
});

function active(
    options: { outgoing?: OutgoingRequest; pending?: Uint8Array[]; isCompacting?: boolean } = {},
): SessionState {
    return {
        kind: "Active",
        outgoing: options.outgoing,
        seenIncoming: new Set(),
        pending: options.pending ?? [],
        expiry: 10n,
        isCompacting: options.isCompacting ?? false,
    };
}

interface Recorded {
    state: SessionState;
    effects: SessionEffect[];
    changed: boolean;
}

function record(state: SessionState, event: SessionEvent, ctx = context()): Recorded {
    const step = transition(state, event, ctx);
    return { ...step, changed: step.state !== state };
}

function single<K extends SessionEffect["kind"]>(
    recorded: Recorded,
    kind: K,
): Extract<SessionEffect, { kind: K }> {
    const matching = recorded.effects.filter((effect) => effect.kind === kind);
    expect(matching.length).toBe(1);
    return matching[0] as Extract<SessionEffect, { kind: K }>;
}

function none(recorded: Recorded, kind: SessionEffect["kind"]) {
    expect(recorded.effects.filter((effect) => effect.kind === kind).length).toBe(0);
}

const submit = (messageBytes: Uint8Array): SessionEvent => ({
    kind: "SubmitMessage",
    message: messageBytes,
});
const response = (requestId: string): SessionEvent => ({
    kind: "ResponseReceived",
    response: { requestId, expiry: 11n, responseCode: 0 },
});
const completed = (batches: CompactedBatch[]): SessionEvent => ({
    kind: "CompactionCompleted",
    batches,
});

describe("session state machine (Android ActiveStateTest)", () => {
    test("overflowing append with canCompact triggers compaction of outgoing request plus new message", () => {
        const alreadySent = message(60, 1);
        const newMessage = message(60, 2);
        const recorded = record(active({ outgoing: request([alreadySent]) }), submit(newMessage));
        expect(single(recorded, "Compact").messages).toEqual([alreadySent, newMessage]);
        none(recorded, "SubmitRequest");
        none(recorded, "MessageTooLarge");
    });

    test("messages submitted during compaction are buffered without side effects", () => {
        const compacting = record(
            active({ outgoing: request([message(60, 1)]) }),
            submit(message(60, 2)),
        ).state;
        expect(record(compacting, submit(message(10, 3))).effects).toEqual([]);
    });

    test("compaction completed replaces outgoing request with commit and drains buffered messages", () => {
        const alreadySent = message(60, 1);
        const trigger = message(60, 2);
        const buffered = message(10, 3);
        const commit = message(20, 4);
        let state = record(active({ outgoing: request([alreadySent]) }), submit(trigger)).state;
        state = record(state, submit(buffered)).state;
        const recorded = record(state, completed([{ commit, originals: [alreadySent, trigger] }]));
        expect(single(recorded, "SubmitRequest").request.messages).toEqual([commit, buffered]);
        const compacted = single(recorded, "MessagesCompacted");
        expect(compacted.batch.commit).toEqual(commit);
        expect(compacted.batch.originals).toEqual([alreadySent, trigger]);
    });

    test("compaction completed with multiple batches submits all commits and reports each batch", () => {
        const alreadySent = message(60, 1);
        const trigger = message(60, 2);
        const buffered = message(10, 3);
        const firstCommit = message(20, 4);
        const secondCommit = message(20, 5);
        let state = record(active({ outgoing: request([alreadySent]) }), submit(trigger)).state;
        state = record(state, submit(buffered)).state;
        const recorded = record(
            state,
            completed([
                { commit: firstCommit, originals: [alreadySent] },
                { commit: secondCommit, originals: [trigger] },
            ]),
        );
        expect(single(recorded, "SubmitRequest").request.messages).toEqual([
            firstCommit,
            secondCommit,
            buffered,
        ]);
        const compacted = recorded.effects.filter((effect) => effect.kind === "MessagesCompacted");
        expect(compacted.length).toBe(2);
    });

    test("overflowing compaction completed submits prefix and immediately compacts the leftover", () => {
        const original = message(60, 1);
        const extraFirst = message(60, 2);
        const extraSecond = message(60, 3);
        const commit = message(20, 4);
        const recorded = record(
            active({ pending: [original, extraFirst, extraSecond], isCompacting: true }),
            completed([{ commit, originals: [original] }]),
        );
        expect(single(recorded, "SubmitRequest").request.messages).toEqual([commit, extraFirst]);
        expect(single(recorded, "Compact").messages).toEqual([extraSecond]);
        expect(record(recorded.state, submit(message(10, 5))).effects).toEqual([]);
    });

    test("second round compaction completed supersedes the in-flight prefix request without duplicates", () => {
        const original = message(60, 1);
        const extraFirst = message(60, 2);
        const extraSecond = message(60, 3);
        const firstCommit = message(20, 4);
        const secondCommit = message(20, 5);
        const ctx = context();
        const firstRound = record(
            active({ pending: [original, extraFirst, extraSecond], isCompacting: true }),
            completed([{ commit: firstCommit, originals: [original] }]),
            ctx,
        );
        const prefixId = single(firstRound, "SubmitRequest").request.requestId;
        const recorded = record(
            firstRound.state,
            completed([{ commit: secondCommit, originals: [extraSecond] }]),
            ctx,
        );
        const submitted = single(recorded, "SubmitRequest").request;
        expect(submitted.requestId).not.toBe(prefixId);
        expect(submitted.messages).toEqual([firstCommit, extraFirst, secondCommit]);
        none(recorded, "Compact");
    });

    test("commits-only remainder ends the compaction cycle and drains on response", () => {
        const firstCommit = message(60, 4);
        const secondCommit = message(60, 5);
        const recorded = record(
            active({
                pending: [message(60, 1), message(60, 2), message(60, 3)],
                isCompacting: true,
            }),
            completed([
                { commit: firstCommit, originals: [message(60, 1), message(60, 2)] },
                { commit: secondCommit, originals: [message(60, 3)] },
            ]),
        );
        const submitted = single(recorded, "SubmitRequest").request;
        expect(submitted.messages).toEqual([firstCommit]);
        none(recorded, "Compact");
        const drained = record(recorded.state, response(submitted.requestId));
        expect(single(drained, "SubmitRequest").request.messages).toEqual([secondCommit]);
        none(drained, "Compact");
    });

    test("compaction completed while not compacting is ignored", () => {
        const recorded = record(
            active(),
            completed([{ commit: message(20, 4), originals: [message(10, 1)] }]),
        );
        expect(recorded.effects).toEqual([]);
        expect(recorded.changed).toBe(false);
    });

    test("compaction failed while not compacting is ignored", () => {
        const recorded = record(active(), { kind: "CompactionFailed" });
        expect(recorded.effects).toEqual([]);
        expect(recorded.changed).toBe(false);
    });

    test("compaction failed with oversized buffered message rejects it as too large", () => {
        const compacting = record(active(), submit(message(150, 1))).state;
        const recorded = record(compacting, { kind: "CompactionFailed" });
        single(recorded, "MessageTooLarge");
        none(recorded, "SubmitRequest");
    });

    test("compaction failed with no outstanding request drains sendable buffer immediately", () => {
        const trigger = message(60, 2);
        const buffered = message(10, 3);
        let state = record(
            active({ outgoing: request([message(60, 1)], "outstanding") }),
            submit(trigger),
        ).state;
        state = record(state, submit(buffered)).state;
        state = record(state, response("outstanding")).state;
        const recorded = record(state, { kind: "CompactionFailed" });
        expect(single(recorded, "SubmitRequest").request.messages).toEqual([trigger, buffered]);
    });

    test("response received with overflowing buffer triggers re-compaction", () => {
        const bufferedFirst = message(60, 2);
        const bufferedSecond = message(60, 3);
        const recorded = record(
            active({
                outgoing: request([message(60, 1)], "outstanding"),
                pending: [bufferedFirst, bufferedSecond],
            }),
            response("outstanding"),
        );
        expect(single(recorded, "Compact").messages).toEqual([bufferedFirst, bufferedSecond]);
        none(recorded, "SubmitRequest");
    });

    test("compaction failed with outstanding request keeps it and drains on next response", () => {
        const alreadySent = message(60, 1);
        const trigger = message(60, 2);
        let state = record(
            active({ outgoing: request([alreadySent], "outstanding") }),
            submit(trigger),
        ).state;
        const failed = record(state, { kind: "CompactionFailed" });
        none(failed, "SubmitRequest");
        none(failed, "MessageTooLarge");
        state = failed.state;
        const drained = record(state, response("outstanding"));
        expect(single(drained, "ResponseReceived").messages).toEqual([alreadySent]);
        expect(single(drained, "SubmitRequest").request.messages).toEqual([trigger]);
    });

    test("compaction failed with outstanding request appends fitting buffered messages to it", () => {
        const alreadySent = message(60, 1);
        const small = message(10, 2);
        const large = message(60, 3);
        const recorded = record(
            active({
                outgoing: request([alreadySent], "outstanding"),
                pending: [small, large],
                isCompacting: true,
            }),
            { kind: "CompactionFailed" },
        );
        const submitted = single(recorded, "SubmitRequest").request;
        expect(submitted.messages).toEqual([alreadySent, small]);
        expect(submitted.requestId).not.toBe("outstanding");
        const drained = record(recorded.state, response(submitted.requestId));
        expect(single(drained, "SubmitRequest").request.messages).toEqual([large]);
    });

    test("lone oversized message with canCompact is compacted instead of rejected", () => {
        const oversized = message(150, 1);
        const recorded = record(active(), submit(oversized));
        expect(single(recorded, "Compact").messages).toEqual([oversized]);
        none(recorded, "MessageTooLarge");
    });

    test("lone oversized message without canCompact is rejected as too large", () => {
        const recorded = record(active(), submit(message(150, 1)), context(false));
        single(recorded, "MessageTooLarge");
        none(recorded, "Compact");
        expect(recorded.changed).toBe(false);
    });

    test("response for a superseded request id is ignored after compaction", () => {
        const alreadySent = message(60, 1);
        const trigger = message(60, 2);
        let state = record(
            active({ outgoing: request([alreadySent], "superseded") }),
            submit(trigger),
        ).state;
        const done = record(
            state,
            completed([{ commit: message(20, 3), originals: [alreadySent, trigger] }]),
        );
        expect(single(done, "SubmitRequest").request.requestId).not.toBe("superseded");
        state = done.state;
        const recorded = record(state, response("superseded"));
        expect(recorded.effects).toEqual([]);
        expect(recorded.changed).toBe(false);
    });

    test("response received during compaction does not drain buffered messages", () => {
        const compacting = record(
            active({ outgoing: request([message(60, 1)], "outstanding") }),
            submit(message(60, 2)),
        ).state;
        const recorded = record(compacting, response("outstanding"));
        single(recorded, "ResponseReceived");
        none(recorded, "SubmitRequest");
    });

    test("without canCompact growing append submits combined request as before", () => {
        const alreadySent = message(60, 1);
        const newMessage = message(30, 2);
        const recorded = record(
            active({ outgoing: request([alreadySent]) }),
            submit(newMessage),
            context(false),
        );
        expect(single(recorded, "SubmitRequest").request.messages).toEqual([
            alreadySent,
            newMessage,
        ]);
        none(recorded, "Compact");
    });

    test("without canCompact overflowing append buffers and drains on response as before", () => {
        const newMessage = message(60, 2);
        const ctx = context(false);
        const buffered = record(
            active({ outgoing: request([message(60, 1)], "outstanding") }),
            submit(newMessage),
            ctx,
        );
        expect(buffered.effects).toEqual([]);
        const recorded = record(buffered.state, response("outstanding"), ctx);
        expect(single(recorded, "SubmitRequest").request.messages).toEqual([newMessage]);
        none(recorded, "Compact");
    });

    test("incoming request is auto-acked exactly once", () => {
        const incoming = { requestId: "incoming", expiry: 10n, messages: [message(10, 1)] };
        const recorded = record(active(), { kind: "RequestReceived", request: incoming });
        single(recorded, "RequestReceived");
        const ack = single(recorded, "SubmitResponse");
        expect(ack.response.requestId).toBe("incoming");
        expect(ack.response.responseCode).toBe(0);
        expect(
            record(recorded.state, { kind: "RequestReceived", request: incoming }).effects,
        ).toEqual([]);
    });

    test("initialization auto-acks restored unresponded requests", () => {
        const unresponded = { requestId: "unresponded", expiry: 10n, messages: [message(10, 1)] };
        const recorded = record(
            { kind: "Initialization", pending: [] },
            {
                kind: "InitialDataFetched",
                data: {
                    outgoingPending: undefined,
                    incoming: [{ request: unresponded, responded: false }],
                    lastUsedExpiry: 10n,
                },
            },
        );
        single(recorded, "RequestReceived");
        expect(single(recorded, "SubmitResponse").response.requestId).toBe("unresponded");
        expect(
            record(recorded.state, { kind: "RequestReceived", request: unresponded }).effects,
        ).toEqual([]);
    });

    test("initialization with oversized backlog and canCompact compacts on activation", () => {
        const backlog = [message(60, 1), message(60, 2)];
        const recorded = record(
            { kind: "Initialization", pending: backlog },
            {
                kind: "InitialDataFetched",
                data: { outgoingPending: undefined, incoming: [], lastUsedExpiry: 10n },
            },
        );
        expect(single(recorded, "Compact").messages).toEqual(backlog);
        none(recorded, "SubmitRequest");
    });

    test("initialization without canCompact packs backlog partially as before", () => {
        const backlog = [message(60, 1), message(60, 2)];
        const recorded = record(
            { kind: "Initialization", pending: backlog },
            {
                kind: "InitialDataFetched",
                data: { outgoingPending: undefined, incoming: [], lastUsedExpiry: 10n },
            },
            context(false),
        );
        expect(single(recorded, "SubmitRequest").request.messages).toEqual([
            backlog[0] as Uint8Array,
        ]);
        none(recorded, "Compact");
    });
});
