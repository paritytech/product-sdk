// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
    fetchStatements,
    filled,
    proveAndSubmit,
    requestChannel,
    type Statement,
    type StatementsPort,
    silentLogger,
    statementExpiry,
    TopicSubscriptions,
    type VerifiedStatement,
} from "./index.js";

import { LocalProver, ManualClock, StandInStatementStore, settle } from "./testing.js";

const topic = filled(32, 0xab);
const statement = (priority: number, data = filled(4, priority)): Statement => ({
    expiry: statementExpiry(priority),
    channel: requestChannel(topic),
    topics: [topic],
    data,
});

describe("statement transport on the stand-in store", () => {
    test("a channel keeps one statement per signer; replacement needs a higher expiry", async () => {
        const store = new StandInStatementStore();
        const client = store.client();
        const prover = LocalProver.fromLabel("alice");
        const clock = new ManualClock();
        expect((await proveAndSubmit(client, prover, statement(5), clock)).kind).toBe("Accepted");
        const lower = await proveAndSubmit(client, prover, statement(4), clock);
        expect(lower).toEqual({
            kind: "Rejected",
            reason: "channelPriorityTooLow",
            retriable: false,
        });
        expect((await proveAndSubmit(client, prover, statement(6), clock)).kind).toBe("Accepted");
        expect(store.all().length).toBe(1);
        // Another signer has its own slot on the same channel.
        expect(
            (await proveAndSubmit(client, LocalProver.fromLabel("bob"), statement(1), clock)).kind,
        ).toBe("Accepted");
        expect(store.all().length).toBe(2);
    });

    test("a forged proof is refused", async () => {
        const store = new StandInStatementStore();
        const prover = LocalProver.fromLabel("alice");
        const signed = { ...statement(1), proof: await prover.prove(statement(2)) };
        expect((await store.client().submit(signed)).kind).toBe("Rejected");
    });

    test("retriable rejections are retried 10 times, 2 s apart", async () => {
        let calls = 0;
        const flaky: StatementsPort = {
            submit: async () => {
                calls++;
                return calls < 4
                    ? { kind: "Rejected", reason: "noAllowance", retriable: true }
                    : { kind: "Accepted" };
            },
            subscribe: () => () => {},
        };
        const clock = new ManualClock();
        const pending = proveAndSubmit(flaky, LocalProver.fromLabel("alice"), statement(1), clock);
        await settle();
        await clock.advance(10_000);
        expect((await pending).kind).toBe("Accepted");
        expect(calls).toBe(4);
    });

    test("fetch reads the backlog until the complete page", async () => {
        const store = new StandInStatementStore({ backlogPageSize: 2 });
        const clock = new ManualClock();
        for (const label of ["a", "b", "c", "d", "e"]) {
            await proveAndSubmit(store.client(), LocalProver.fromLabel(label), statement(1), clock);
        }
        const fetched = await fetchStatements(store.client(), { matchAll: [topic] }, clock);
        expect(fetched.length).toBe(5);
    });

    test("topic subscriptions deliver backlog and live statements once, and resubscribe after a reset", async () => {
        const store = new StandInStatementStore();
        store.faults.duplicateLive = 1;
        const clock = new ManualClock();
        const received: VerifiedStatement[] = [];
        await proveAndSubmit(store.client(), LocalProver.fromLabel("old"), statement(1), clock);
        const subscriptions = new TopicSubscriptions(store.client(), clock, silentLogger);
        subscriptions.listen(topic, (delivered) => received.push(delivered));
        await settle();
        expect(received.length).toBe(1);
        await proveAndSubmit(store.client(), LocalProver.fromLabel("new"), statement(2), clock);
        await settle();
        expect(received.length).toBe(2);
        store.endAllSubscriptions();
        await clock.advance(1_000);
        await proveAndSubmit(store.client(), LocalProver.fromLabel("after"), statement(3), clock);
        await settle();
        expect(received.length).toBe(3);
        subscriptions.close();
    });
});
