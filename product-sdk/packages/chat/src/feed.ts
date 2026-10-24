// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pushing changes to a room's messages, in order and within the host's rate.
 *
 * The core takes at most 20 `update_feed` calls per second per room and refuses
 * the rest with `RateLimited`. {@link FeedSender} keeps one ordered queue per room,
 * spaces its sends to that rate, sends a refused update again after a pause, and
 * folds consecutive edits of one message into the newest (the host's screen would
 * draw only the last anyway).
 *
 * @module
 */
import {
    type ChatFeedUpdate,
    ChatRoomError,
    type ChatRooms,
    type HostError,
} from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import { type Clock, systemClock } from "@parity/product-sdk-utils";

import { ROOM_RATES } from "./limits.js";

const log = createLogger("chat:feed");

/** Options of a {@link FeedSender}. */
export interface FeedSenderOptions {
    clock?: Clock;
    /** Sends per second per room. Default 20, the core's bound. */
    perSecond?: number;
    /** Pause before an update refused with `RateLimited` is sent again. Default 1 s. */
    retryDelayMs?: number;
    /** Times an update is sent again after `RateLimited`. Default 3. */
    maxRetries?: number;
    /** Called for an update the host refused for good. Default: logged. */
    onFailure?: (roomId: string, update: ChatFeedUpdate, error: HostError) => void;
}

interface RoomQueue {
    pending: ChatFeedUpdate[];
    running: Promise<void> | undefined;
    lastSentAt: number;
}

function isRateLimited(error: HostError): boolean {
    return error instanceof ChatRoomError && error.failure.tag === "RateLimited";
}

/**
 * Sends feed updates per room, in the order pushed.
 *
 * @example
 * ```ts
 * const feed = new FeedSender(rooms);
 * feed.push("support", { tag: "New", value: answer });
 * await feed.flushed();
 * ```
 */
export class FeedSender {
    private readonly queues = new Map<string, RoomQueue>();
    private readonly clock: Clock;
    private readonly spacingMs: number;

    constructor(
        private readonly rooms: Pick<ChatRooms, "updateFeed">,
        private readonly options: FeedSenderOptions = {},
    ) {
        this.clock = options.clock ?? systemClock;
        this.spacingMs = 1000 / (options.perSecond ?? ROOM_RATES.updateFeed);
    }

    /** Queues `update` for `roomId`. */
    push(roomId: string, update: ChatFeedUpdate): void {
        const queue = this.queueOf(roomId);
        const last = queue.pending[queue.pending.length - 1];
        if (
            update.tag === "Edited" &&
            last?.tag === "Edited" &&
            last.value.messageId === update.value.messageId
        ) {
            queue.pending[queue.pending.length - 1] = update;
        } else {
            queue.pending.push(update);
        }
        queue.running ??= this.drain(roomId, queue);
    }

    /** Resolves once every update pushed so far was sent or given up on. */
    async flushed(): Promise<void> {
        for (;;) {
            const running = [...this.queues.values()].flatMap((queue) =>
                queue.running ? [queue.running] : [],
            );
            if (running.length === 0) return;
            await Promise.all(running);
        }
    }

    private queueOf(roomId: string): RoomQueue {
        let queue = this.queues.get(roomId);
        if (!queue) {
            queue = { pending: [], running: undefined, lastSentAt: Number.NEGATIVE_INFINITY };
            this.queues.set(roomId, queue);
        }
        return queue;
    }

    private async drain(roomId: string, queue: RoomQueue): Promise<void> {
        while (queue.pending.length > 0) {
            const update = queue.pending.shift() as ChatFeedUpdate;
            await this.send(roomId, queue, update);
        }
        queue.running = undefined;
    }

    private async send(roomId: string, queue: RoomQueue, update: ChatFeedUpdate): Promise<void> {
        const maxRetries = this.options.maxRetries ?? 3;
        for (let attempt = 0; ; attempt++) {
            const wait = queue.lastSentAt + this.spacingMs - this.clock.nowMs();
            if (wait > 0) await this.clock.sleep(wait);
            queue.lastSentAt = this.clock.nowMs();
            const sent = await this.rooms.updateFeed(roomId, update);
            if (sent.ok) return;
            if (isRateLimited(sent.error) && attempt < maxRetries) {
                await this.clock.sleep(this.options.retryDelayMs ?? 1_000);
                continue;
            }
            if (this.options.onFailure) this.options.onFailure(roomId, update, sent.error);
            else log.warn(`feed update to ${roomId} refused`, { reason: sent.error.message });
            return;
        }
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { ok, err } = await import("@parity/product-sdk-host");
    const { ManualClock, settle } = await import("@parity/product-sdk-utils/testing");

    const edited = (messageId: string, text: string): ChatFeedUpdate => ({
        tag: "Edited",
        value: { messageId, body: { tag: "Text", value: { text } }, editedAt: 1n },
    });

    function recorder(answers: ("ok" | "rate" | "fail")[] = []) {
        const sent: { roomId: string; update: ChatFeedUpdate; at: number }[] = [];
        let clock: Clock | undefined;
        const rooms = {
            async updateFeed(roomId: string, update: ChatFeedUpdate) {
                sent.push({ roomId, update, at: clock?.nowMs() ?? 0 });
                const answer = answers.shift() ?? "ok";
                if (answer === "ok") return ok(undefined);
                return err(
                    new ChatRoomError(
                        "updateFeed",
                        answer === "rate" ? { tag: "RateLimited" } : { tag: "NotOwner" },
                    ),
                );
            },
        };
        return {
            sent,
            rooms,
            use: (manual: Clock) => {
                clock = manual;
            },
        };
    }

    test("updates go out in order, spaced to 20 a second per room", async () => {
        const clock = new ManualClock(0);
        const { sent, rooms, use } = recorder();
        use(clock);
        const feed = new FeedSender(rooms, { clock });
        for (let index = 0; index < 3; index++)
            feed.push("r", {
                tag: "StatusChanged",
                value: { messageId: `${index}`, status: "Sent" },
            });
        const done = feed.flushed();
        await settle();
        await clock.advance(200);
        await done;
        expect(sent.map((entry) => entry.at)).toEqual([0, 50, 100]);
    });

    test("consecutive edits of one message fold into the newest", async () => {
        const clock = new ManualClock(0);
        const { sent, rooms } = recorder();
        const feed = new FeedSender(rooms, { clock });
        feed.push("r", { tag: "StatusChanged", value: { messageId: "m", status: "Preparing" } });
        feed.push("r", edited("m", "he"));
        feed.push("r", edited("m", "hel"));
        feed.push("r", edited("m", "hello"));
        const done = feed.flushed();
        await settle();
        await clock.advance(1000);
        await done;
        expect(sent.map((entry) => entry.update)).toEqual([
            { tag: "StatusChanged", value: { messageId: "m", status: "Preparing" } },
            edited("m", "hello"),
        ]);
    });

    test("a rate-limited update is sent again; another refusal is reported", async () => {
        const clock = new ManualClock(0);
        const { sent, rooms } = recorder(["rate", "ok", "fail"]);
        const failures: string[] = [];
        const feed = new FeedSender(rooms, {
            clock,
            onFailure: (_roomId, _update, error) => failures.push(error.message),
        });
        feed.push("r", edited("a", "1"));
        feed.push("r", { tag: "StatusChanged", value: { messageId: "b", status: "Sent" } });
        const done = feed.flushed();
        for (let step = 0; step < 10; step++) {
            await settle();
            await clock.advance(500);
        }
        await done;
        expect(sent).toHaveLength(3);
        expect(failures).toEqual(["updateFeed: NotOwner"]);
    });
}
