// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Calls in a product's rooms.
 *
 * The chat side of a call is a room state the product sets (`Ringing`, `Active`)
 * and events the user produces (`CallRequested`, `CallAnswered`, `CallEnded`); the
 * audio and video run in the host's call engine, which the product starts with
 * call media and feeds the other side's signals. How the call travels between
 * the two sides (the ring, the acceptance, the engine's signals, the end) is the
 * product's own channel: {@link CallSignalling}.
 *
 * {@link RoomCalls} runs one call at a time. Two flows decide which side's engine
 * makes the media offer:
 *
 * - `"answerer"` (the default, the call-media RFC's flow): the caller rings, the
 *   side that accepts starts as the offerer, and the caller starts once it learns
 *   of the acceptance.
 * - `"caller"`: the caller's engine starts at once and its first signal is the
 *   offer, which rings the other side; the side that accepts starts as the
 *   answerer with the offer it kept. The native person chat calls this way.
 *
 * @module
 */
import type {
    CallMedia,
    ChatRooms,
    HostChatRoomEventsSubscribeItem,
} from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import { type Clock, type IdSource, systemClock, uuidSource } from "@parity/product-sdk-utils";

const log = createLogger("chat:calls");

/** An offer or a ring older than this does not ring. */
export const CALL_RING_MAX_AGE_MS = 30_000;

/** What a call is, as {@link CallSignalling} sees it. */
export interface CallInfo {
    roomId: string;
    callId: string;
    video: boolean;
    /** This side's engine makes the media offer. */
    offerer: boolean;
}

/** How a product carries a call to the other side of a room, through its own channel. */
export interface CallSignalling {
    /** `"answerer"` flow: ring the other side. */
    ring?(call: CallInfo): Promise<void>;
    /** `"answerer"` flow: tell the caller the user accepted. */
    accept?(call: CallInfo): Promise<void>;
    /**
     * Carry a signal of this side's engine to the other side. In the `"caller"` flow
     * the caller's first signal is the offer. Answer `{ ended: true }` when the
     * signal ends the call (the user hung up on the host's call screen).
     */
    signal(call: CallInfo, signal: Uint8Array): Promise<{ ended?: boolean } | undefined>;
    /** Tell the other side the call ended: declined, stale, busy, hung up, or the engine failed. */
    close(roomId: string, callId: string): Promise<void>;
}

/** Options of {@link RoomCalls}. */
export interface RoomCallsOptions {
    rooms: Pick<ChatRooms, "setCall">;
    media: Pick<CallMedia, "start" | "signal" | "stop">;
    signalling: CallSignalling;
    /** Which side's engine makes the media offer. Default `"answerer"`. */
    offers?: "answerer" | "caller";
    /** Called when the user answers a ringing call: the native chat marks the call message read. */
    onAnswered?(call: CallInfo): Promise<void> | void;
    clock?: Clock;
    /** Ids of calls the user starts when the host chose none. */
    ids?: IdSource;
}

/** What the other side sends to ring this one. */
export interface RemoteRing {
    callId: string;
    video: boolean;
    /** When the other side rang, in milliseconds since the Unix epoch. */
    sentAt: number;
    /** The participant who calls, for the host's incoming call screen. */
    caller?: string;
    /** `"caller"` flow: the offer of the caller's engine, kept until the user answers. */
    signal?: Uint8Array;
}

interface Call extends CallInfo {
    phase: "Ringing" | "Active";
    /** Signals of the other side the engine has not had yet. */
    pending: Uint8Array[];
    /** The other side's engine answered; later answers come from its other devices. */
    answered: boolean;
    /** The media runs. */
    started: boolean;
}

/**
 * One call at a time across a product's rooms.
 *
 * @example
 * ```ts
 * const calls = new RoomCalls({ rooms, media, signalling: myChannel });
 * rooms.subscribeRoomEvents((item) => void calls.onRoomEvent(item));
 * myChannel.onRing((roomId, ring) => calls.remoteRing(roomId, ring));
 * ```
 */
export class RoomCalls {
    private call: Call | undefined;
    private readonly closed = new Set<string>();
    /** Answers that came before their ring, such as from a lock screen before the worker read the offer. */
    private readonly earlyAnswers = new Map<string, { accept: boolean; at: number }>();
    private readonly clock: Clock;

    constructor(private readonly options: RoomCallsOptions) {
        this.clock = options.clock ?? systemClock;
    }

    private get offers(): "answerer" | "caller" {
        return this.options.offers ?? "answerer";
    }

    /** The call in progress, if any. */
    get current(): Readonly<CallInfo & { phase: "Ringing" | "Active" }> | undefined {
        const call = this.call;
        return (
            call && {
                roomId: call.roomId,
                callId: call.callId,
                video: call.video,
                offerer: call.offerer,
                phase: call.phase,
            }
        );
    }

    /** What the user or the host's engine did in a room. */
    async onRoomEvent({ roomId, event }: HostChatRoomEventsSubscribeItem): Promise<void> {
        switch (event.tag) {
            case "CallRequested":
                return this.start(roomId, event.value.video, event.value.callId);
            case "CallAnswered":
                return this.answer(event.value.callId, event.value.accept);
            case "CallEnded":
                return this.end(event.value.callId, true);
            case "CallSignal":
                return this.relay(event.value.callId, hexBytes(event.value.signal));
        }
    }

    /** The other side rang. A stale ring, or one while a call runs, is answered with a close. */
    async remoteRing(roomId: string, ring: RemoteRing): Promise<void> {
        const { callId } = ring;
        if (this.closed.has(callId) || this.call?.callId === callId) return;
        if (this.clock.nowMs() - ring.sentAt > CALL_RING_MAX_AGE_MS || this.call) {
            await this.tellClosed(roomId, callId);
            return;
        }
        this.call = {
            roomId,
            callId,
            video: ring.video,
            offerer: this.offers === "answerer",
            phase: "Ringing",
            pending: ring.signal ? [ring.signal] : [],
            answered: this.offers === "caller",
            started: false,
        };
        await this.setCall(roomId, {
            tag: "Ringing",
            value: {
                callId,
                video: ring.video,
                ...(ring.caller !== undefined ? { caller: ring.caller } : {}),
            },
        });
        const early = this.takeEarlyAnswer(callId);
        if (early !== undefined) await this.answer(callId, early);
    }

    /** `"answerer"` flow: the other side accepted this side's call; its engine makes the offer. */
    async remoteAccept(roomId: string, callId: string): Promise<void> {
        const call = this.call;
        if (!call || call.callId !== callId || call.roomId !== roomId || call.started) return;
        await this.startMedia(call);
    }

    /** A signal of the other side's engine. `answer` marks the answer to an offer: only the first one counts. */
    async remoteSignal(
        roomId: string,
        callId: string,
        signal: Uint8Array,
        options: { answer?: boolean } = {},
    ): Promise<void> {
        const call = this.call;
        if (!call || call.callId !== callId || call.roomId !== roomId) return;
        if (options.answer) {
            if (call.answered) return;
            call.answered = true;
        }
        if (!call.started) {
            call.pending.push(signal);
            return;
        }
        await this.signalHost(call, signal);
    }

    /** The other side ended the call. */
    async remoteClose(roomId: string, callId: string): Promise<void> {
        this.closed.add(callId);
        const call = this.call;
        if (call?.callId === callId && call.roomId === roomId) await this.finish(call);
    }

    private async start(
        roomId: string,
        video: boolean,
        chosenId: string | undefined,
    ): Promise<void> {
        if (this.call) return;
        const callId = chosenId ?? (this.options.ids ?? uuidSource).next();
        const call: Call = {
            roomId,
            callId,
            video,
            offerer: this.offers === "caller",
            phase: "Active",
            pending: [],
            answered: false,
            started: false,
        };
        this.call = call;
        await this.setCall(roomId, {
            tag: "Active",
            value: { callId, video, startedAt: BigInt(this.clock.nowMs()) },
        });
        if (this.offers === "caller") {
            await this.startMedia(call);
            return;
        }
        await this.options.signalling
            .ring?.(this.infoOf(call))
            .catch((error: unknown) =>
                log.warn("the ring was not sent", { reason: reasonOf(error) }),
            );
    }

    private async answer(callId: string, accept: boolean): Promise<void> {
        const call = this.call;
        if (!call || call.callId !== callId) {
            if (!this.closed.has(callId))
                this.earlyAnswers.set(callId, { accept, at: this.clock.nowMs() });
            return;
        }
        if (call.phase !== "Ringing") return;
        if (!accept) return this.end(callId, true);
        await Promise.resolve(this.options.onAnswered?.(this.infoOf(call))).catch(
            (error: unknown) => log.warn("onAnswered failed", { reason: reasonOf(error) }),
        );
        call.phase = "Active";
        await this.setCall(call.roomId, {
            tag: "Active",
            value: { callId, video: call.video, startedAt: BigInt(this.clock.nowMs()) },
        });
        if (this.offers === "answerer")
            await this.options.signalling
                .accept?.(this.infoOf(call))
                .catch((error: unknown) =>
                    log.warn("the acceptance was not sent", { reason: reasonOf(error) }),
                );
        await this.startMedia(call);
    }

    private takeEarlyAnswer(callId: string): boolean | undefined {
        const now = this.clock.nowMs();
        for (const [id, answer] of this.earlyAnswers) {
            if (now - answer.at > CALL_RING_MAX_AGE_MS) this.earlyAnswers.delete(id);
        }
        const answer = this.earlyAnswers.get(callId);
        this.earlyAnswers.delete(callId);
        return answer?.accept;
    }

    private async startMedia(call: Call): Promise<void> {
        const started = await this.options.media.start({
            roomId: call.roomId,
            callId: call.callId,
            video: call.video,
            offerer: call.offerer,
        });
        if (!started.ok) {
            log.warn("call media did not start", { reason: started.error.message });
            return this.end(call.callId, true);
        }
        call.started = true;
        for (const signal of call.pending.splice(0)) await this.signalHost(call, signal);
    }

    private async signalHost(call: Call, signal: Uint8Array): Promise<void> {
        const sent = await this.options.media.signal(call.roomId, call.callId, signal);
        if (!sent.ok)
            log.warn("a call signal did not reach the engine", { reason: sent.error.message });
    }

    private async relay(callId: string, signal: Uint8Array): Promise<void> {
        const call = this.call;
        if (!call || call.callId !== callId) return;
        const outcome = await this.options.signalling
            .signal(this.infoOf(call), signal)
            .catch((error: unknown) => {
                log.warn("a call signal was not sent", { reason: reasonOf(error) });
                return undefined;
            });
        if (outcome?.ended) {
            this.closed.add(callId);
            await this.finish(call);
        }
    }

    /** Ends the call; `tell` closes it on the other side too. */
    private async end(callId: string, tell: boolean): Promise<void> {
        const call = this.call;
        if (!call || call.callId !== callId) return;
        this.closed.add(callId);
        if (tell) await this.tellClosed(call.roomId, callId);
        await this.finish(call);
    }

    private async finish(call: Call): Promise<void> {
        if (this.call !== call) return;
        this.call = undefined;
        if (call.started) await this.options.media.stop(call.roomId, call.callId);
        await this.setCall(call.roomId, undefined);
    }

    private async tellClosed(roomId: string, callId: string): Promise<void> {
        await this.options.signalling
            .close(roomId, callId)
            .catch((error: unknown) =>
                log.warn("the close was not sent", { reason: reasonOf(error) }),
            );
    }

    private async setCall(
        roomId: string,
        call: Parameters<ChatRooms["setCall"]>[1],
    ): Promise<void> {
        const set = await this.options.rooms.setCall(roomId, call);
        if (!set.ok) log.warn("the room's call was not shown", { reason: set.error.message });
    }

    private infoOf(call: Call): CallInfo {
        return {
            roomId: call.roomId,
            callId: call.callId,
            video: call.video,
            offerer: call.offerer,
        };
    }
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hexBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(clean.length / 2);
    for (let index = 0; index < out.length; index++)
        out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    return out;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { createChatTestbed } = await import("./testing.js");
    const { createCallMedia } = await import("@parity/product-sdk-host");

    function setup(offers: "answerer" | "caller") {
        const testbed = createChatTestbed();
        const media = createCallMedia(testbed.client);
        if (!media) throw new Error("no call media");
        const carried: string[] = [];
        const calls = new RoomCalls({
            rooms: testbed.rooms,
            media,
            offers,
            clock: testbed.clock,
            ids: { next: () => "c1" },
            signalling: {
                ring: async ({ callId }) => void carried.push(`ring ${callId}`),
                accept: async ({ callId }) => void carried.push(`accept ${callId}`),
                signal: async ({ callId }, signal) => {
                    carried.push(`signal ${callId} ${signal.length}`);
                    return signal[0] === 0xff ? { ended: true } : undefined;
                },
                close: async (_roomId, callId) => void carried.push(`close ${callId}`),
            },
        });
        return { ...testbed, calls, carried };
    }

    async function withRoom(testbed: ReturnType<typeof setup>) {
        await testbed.rooms.createRoom({ roomId: "r", name: "R", icon: "" });
        return testbed;
    }

    const press = (video = false) => ({
        roomId: "r",
        event: { tag: "CallRequested" as const, value: { video } },
    });

    describe("the call-media RFC's flow", () => {
        test("the caller rings; the side that accepts offers; the caller starts once it hears", async () => {
            const caller = await withRoom(setup("answerer"));
            caller.host.emitRoomEvent("r", { tag: "CallRequested", value: { video: true } });
            await caller.calls.onRoomEvent(press(true));
            expect(caller.carried).toEqual(["ring c1"]);
            expect(caller.host.room("r").call?.tag).toBe("Active");
            expect(caller.host.callMediaLog).toEqual([]);
            await caller.calls.remoteAccept("r", "c1");
            expect(caller.host.callMediaLog).toEqual([
                { kind: "start", roomId: "r", callId: "c1", video: true, offerer: false },
            ]);

            const callee = await withRoom(setup("answerer"));
            await callee.calls.remoteRing("r", {
                callId: "c1",
                video: true,
                sentAt: callee.clock.nowMs(),
            });
            expect(callee.host.room("r").call?.tag).toBe("Ringing");
            callee.host.emitRoomEvent("r", {
                tag: "CallAnswered",
                value: { callId: "c1", accept: true },
            });
            await callee.calls.onRoomEvent({
                roomId: "r",
                event: { tag: "CallAnswered", value: { callId: "c1", accept: true } },
            });
            expect(callee.carried).toEqual(["accept c1"]);
            expect(callee.host.callMediaLog[0]).toEqual({
                kind: "start",
                roomId: "r",
                callId: "c1",
                video: true,
                offerer: true,
            });
        });
    });

    describe("the native flow", () => {
        test("the caller's engine starts at once and a signal that ends the call ends it", async () => {
            const caller = await withRoom(setup("caller"));
            caller.host.emitRoomEvent("r", { tag: "CallRequested", value: { video: false } });
            await caller.calls.onRoomEvent(press());
            expect(caller.host.callMediaLog[0]).toMatchObject({ kind: "start", offerer: true });
            await caller.calls.onRoomEvent({
                roomId: "r",
                event: { tag: "CallSignal", value: { callId: "c1", signal: "0x0102" } },
            });
            await caller.calls.onRoomEvent({
                roomId: "r",
                event: { tag: "CallSignal", value: { callId: "c1", signal: "0xff" } },
            });
            expect(caller.carried).toEqual(["signal c1 2", "signal c1 1"]);
            expect(caller.calls.current).toBeUndefined();
            expect(caller.host.room("r").call).toBeUndefined();
            expect(caller.host.callMediaLog.at(-1)).toEqual({
                kind: "stop",
                roomId: "r",
                callId: "c1",
            });
        });

        test("an offer rings and answering starts as answerer with the kept offer; only the first answer counts", async () => {
            const callee = await withRoom(setup("caller"));
            await callee.calls.remoteRing("r", {
                callId: "c1",
                video: false,
                sentAt: callee.clock.nowMs(),
                signal: new Uint8Array([1]),
            });
            callee.host.emitRoomEvent("r", {
                tag: "CallAnswered",
                value: { callId: "c1", accept: true },
            });
            await callee.calls.onRoomEvent({
                roomId: "r",
                event: { tag: "CallAnswered", value: { callId: "c1", accept: true } },
            });
            expect(callee.host.callMediaLog.map((entry) => entry.kind)).toEqual([
                "start",
                "signal",
            ]);
            expect(callee.host.callMediaLog[0]).toMatchObject({ offerer: false });
            await callee.calls.remoteSignal("r", "c1", new Uint8Array([2]), { answer: true });
            expect(callee.host.callMediaLog).toHaveLength(2);
        });
    });

    test("an answer before its ring applies when the ring arrives; a stale ring and a second call are closed", async () => {
        const testbed = await withRoom(setup("caller"));
        await testbed.rooms.createRoom({ roomId: "s", name: "S", icon: "" });
        testbed.host.emitRoomEvent("r", {
            tag: "CallAnswered",
            value: { callId: "c1", accept: true },
        });
        await testbed.calls.onRoomEvent({
            roomId: "r",
            event: { tag: "CallAnswered", value: { callId: "c1", accept: true } },
        });
        await testbed.calls.remoteRing("r", {
            callId: "c1",
            video: false,
            sentAt: testbed.clock.nowMs(),
        });
        expect(testbed.calls.current?.phase).toBe("Active");
        await testbed.calls.remoteRing("s", {
            callId: "c2",
            video: false,
            sentAt: testbed.clock.nowMs(),
        });
        await testbed.calls.remoteRing("s", {
            callId: "c3",
            video: false,
            sentAt: testbed.clock.nowMs() - CALL_RING_MAX_AGE_MS - 1,
        });
        expect(testbed.carried).toEqual(["close c2", "close c3"]);
    });

    test("declining closes the call and starts nothing; media without consent ends the call", async () => {
        const declined = await withRoom(setup("caller"));
        await declined.calls.remoteRing("r", {
            callId: "c1",
            video: false,
            sentAt: declined.clock.nowMs(),
        });
        await declined.calls.onRoomEvent({
            roomId: "r",
            event: { tag: "CallAnswered", value: { callId: "c1", accept: false } },
        });
        expect(declined.carried).toEqual(["close c1"]);
        expect(declined.host.callMediaLog).toEqual([]);

        const unconsented = await withRoom(setup("caller"));
        // The double grants media only after the user's press reached it as a room event.
        await unconsented.calls.onRoomEvent(press());
        expect(unconsented.carried).toEqual(["close c1"]);
        expect(unconsented.host.room("r").call).toBeUndefined();
    });
}
