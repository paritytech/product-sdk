// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
    CONTACT_MAX_STATEMENT_BYTES,
    CommunicationSession,
    type CompactedBatch,
    fromUtf8,
    MultiDeviceLane,
    PairwiseLane,
    type SessionLane,
    type SessionListener,
    silentLogger,
    TopicSubscriptions,
    utf8,
    uuidSource,
} from "./index.js";

import {
    ManualClock,
    StandInStatementStore,
    settle,
    type TestIdentity,
    testIdentity,
} from "./testing.js";

class Recorder implements SessionListener {
    received: string[] = [];
    sent: string[] = [];
    delivered: string[] = [];
    notFound = 0;
    failed: string[] = [];
    onMessagesReceived(_requestId: string, messages: Uint8Array[]) {
        for (const message of messages)
            if (!this.received.includes(fromUtf8(message))) this.received.push(fromUtf8(message));
    }
    onMessagesSent(messages: Uint8Array[]) {
        this.sent.push(...messages.map(fromUtf8));
    }
    onMessagesDelivered(messages: Uint8Array[]) {
        this.delivered.push(...messages.map(fromUtf8));
    }
    onMessagesFailedToSend(messages: Uint8Array[]) {
        this.failed.push(...messages.map(fromUtf8));
    }
    onMessageTooLarge() {}
    onSentMessagesNotFound() {
        this.notFound++;
    }
    onMessagesCompacted(_batch: CompactedBatch) {}
}

function pairwise(me: TestIdentity, peer: TestIdentity): SessionLane {
    return new PairwiseLane({
        localAccount: me.identity.account,
        remoteAccount: peer.identity.account,
        chatSecret: me.chatSecret,
        peerChatKey: peer.chatPublicKey,
    });
}

function session(
    store: StandInStatementStore,
    clock: ManualClock,
    me: TestIdentity,
    lane: SessionLane,
    listener: SessionListener,
) {
    return new CommunicationSession({
        statements: store.client(),
        subscriptions: new TopicSubscriptions(store.client(), clock, silentLogger),
        prover: me.identity,
        clock,
        ids: uuidSource,
        logger: silentLogger,
        lane,
        maxStatementBytes: CONTACT_MAX_STATEMENT_BYTES,
        listener,
    });
}

describe("communication sessions on the stand-in store", () => {
    test("pairwise: messages both ways are received once, sent and delivered", async () => {
        const store = new StandInStatementStore();
        const clock = new ManualClock();
        const alice = testIdentity("alice");
        const bob = testIdentity("bob");
        const aliceLog = new Recorder();
        const bobLog = new Recorder();
        const aliceSession = session(store, clock, alice, pairwise(alice, bob), aliceLog);
        const bobSession = session(store, clock, bob, pairwise(bob, alice), bobLog);
        await aliceSession.start();
        await bobSession.start();
        await aliceSession.submit(utf8("hello bob"));
        await settle();
        await aliceSession.submit(utf8("second"));
        await settle();
        await bobSession.submit(utf8("hi alice"));
        await settle(40);
        expect(bobLog.received).toEqual(["hello bob", "second"]);
        expect(aliceLog.received).toEqual(["hi alice"]);
        expect(aliceLog.delivered).toContain("second");
        expect(bobLog.delivered).toContain("hi alice");
        expect(aliceLog.sent).toContain("hello bob");
    });

    test("burst while the peer is offline is delivered once when it comes online", async () => {
        const store = new StandInStatementStore();
        const clock = new ManualClock();
        const alice = testIdentity("alice");
        const bob = testIdentity("bob");
        const aliceLog = new Recorder();
        const aliceSession = session(store, clock, alice, pairwise(alice, bob), aliceLog);
        await aliceSession.start();
        for (let index = 0; index < 50; index++) {
            await aliceSession.submit(utf8(`message ${index}`));
            await clock.advance(1_000);
        }
        await settle();
        const bobLog = new Recorder();
        const bobSession = session(store, clock, bob, pairwise(bob, alice), bobLog);
        await bobSession.start();
        for (let round = 0; round < 60; round++) {
            await clock.advance(1_000);
            await settle();
            if (bobLog.received.length === 50) break;
        }
        expect(bobLog.received.length).toBe(50);
        expect(bobLog.received[0]).toBe("message 0");
        expect(bobLog.received[49]).toBe("message 49");
    });

    test("restart restores the unacknowledged request and re-acks unanswered ones", async () => {
        const store = new StandInStatementStore();
        const clock = new ManualClock();
        const alice = testIdentity("alice");
        const bob = testIdentity("bob");
        const aliceSession = session(store, clock, alice, pairwise(alice, bob), new Recorder());
        await aliceSession.start();
        await aliceSession.submit(utf8("before restart"));
        await settle();
        aliceSession.stop();
        const restartedLog = new Recorder();
        const restarted = session(store, clock, alice, pairwise(alice, bob), restartedLog);
        await restarted.start();
        await settle();
        expect(restartedLog.notFound).toBe(0);
        const state = restarted.currentState;
        expect(state.kind === "Active" && state.outgoing?.messages.map(fromUtf8)).toEqual([
            "before restart",
        ]);
        const bobLog = new Recorder();
        const bobSession = session(store, clock, bob, pairwise(bob, alice), bobLog);
        await bobSession.start();
        await settle(40);
        expect(bobLog.received).toEqual(["before restart"]);
    });

    test("multi-device: a user with two devices exchanges with a peer through per-device envelopes", async () => {
        const store = new StandInStatementStore();
        const clock = new ManualClock();
        const alice = testIdentity("alice");
        const bobPhone = testIdentity("bob", "phone");
        const bobDesktop = {
            ...testIdentity("bob", "desktop"),
            identity: testIdentity("bob-desktop-statement").identity,
        };
        const bobDevices = [
            {
                statementAccountId: bobPhone.identity.account,
                encryptionPublicKey: bobPhone.devicePublicKey,
            },
            {
                statementAccountId: bobDesktop.identity.account,
                encryptionPublicKey: bobDesktop.devicePublicKey,
            },
        ];
        const aliceDevices = [
            {
                statementAccountId: alice.identity.account,
                encryptionPublicKey: alice.devicePublicKey,
            },
        ];
        const aliceLane = new MultiDeviceLane({
            statementAccount: alice.identity.account,
            identityAccount: alice.identity.account,
            remoteAccount: bobPhone.identity.account,
            chatSecret: alice.chatSecret,
            deviceSecret: alice.deviceSecret,
            peerChatKey: bobPhone.chatPublicKey,
            roster: () => bobDevices,
        });
        const bobLane = (device: TestIdentity, statementAccount: Uint8Array) =>
            new MultiDeviceLane({
                statementAccount,
                identityAccount: bobPhone.identity.account,
                remoteAccount: alice.identity.account,
                chatSecret: bobPhone.chatSecret,
                deviceSecret: device.deviceSecret,
                peerChatKey: alice.chatPublicKey,
                roster: () => aliceDevices,
            });
        const aliceLog = new Recorder();
        const phoneLog = new Recorder();
        const desktopLog = new Recorder();
        const aliceSession = session(store, clock, alice, aliceLane, aliceLog);
        const phoneSession = session(
            store,
            clock,
            bobPhone,
            bobLane(bobPhone, bobPhone.identity.account),
            phoneLog,
        );
        const desktopSession = session(
            store,
            clock,
            bobDesktop,
            bobLane(bobDesktop, bobDesktop.identity.account),
            desktopLog,
        );
        await aliceSession.start();
        await phoneSession.start();
        await desktopSession.start();
        await aliceSession.submit(utf8("to both of bob's devices"));
        await settle(40);
        expect(phoneLog.received).toEqual(["to both of bob's devices"]);
        expect(desktopLog.received).toEqual(["to both of bob's devices"]);
        await desktopSession.submit(utf8("from bob's desktop"));
        await settle(40);
        expect(aliceLog.received).toEqual(["from bob's desktop"]);
        expect(aliceLog.delivered).toContain("to both of bob's devices");
    });
});
