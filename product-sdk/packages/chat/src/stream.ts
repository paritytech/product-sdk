// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Streaming a long answer into a room as it is written.
 *
 * The base RFC's pattern: `New` with `status: Preparing`, then `Edited` as text
 * arrives, then `StatusChanged` to `Sent`. The feed folds consecutive edits, so a
 * fast writer costs only as many updates as the rate allows.
 *
 * @module
 */
import type { ChatRoomMessage } from "@parity/product-sdk-host";
import { type Clock, systemClock } from "@parity/product-sdk-utils";

import { text } from "./builders.js";
import type { FeedSender } from "./feed.js";

/** A message being written into a room. */
export interface StreamingMessage {
    /** The text so far. */
    readonly text: string;
    /** Adds `chunk` to the text and pushes the edit. */
    append(chunk: string): void;
    /** Replaces the text and pushes the edit. */
    replace(whole: string): void;
    /** The message is complete: its status becomes `Sent`. */
    finish(): void;
    /** The message could not be completed: its status becomes `Failed`. */
    fail(): void;
}

/**
 * Starts streaming `draft` into `roomId`: pushes it as `New` with `Preparing`, and
 * returns the handle that writes the rest. The draft's body sets the first text.
 *
 * @example
 * ```ts
 * const answer = streamMessage(feed, roomId, message({ messageId, from: "product", timestamp, body: text("") }));
 * for await (const chunk of model.stream(prompt)) answer.append(chunk);
 * answer.finish();
 * ```
 */
export function streamMessage(
    feed: FeedSender,
    roomId: string,
    draft: ChatRoomMessage,
    options: { clock?: Clock } = {},
): StreamingMessage {
    const clock = options.clock ?? systemClock;
    let current = draft.body.tag === "Text" ? draft.body.value.text : "";
    let open = true;
    feed.push(roomId, {
        tag: "New",
        value: { ...draft, body: text(current), status: "Preparing" },
    });
    const edit = () =>
        feed.push(roomId, {
            tag: "Edited",
            value: {
                messageId: draft.messageId,
                body: text(current),
                editedAt: BigInt(clock.nowMs()),
            },
        });
    const close = (status: "Sent" | "Failed") => {
        if (!open) return;
        open = false;
        feed.push(roomId, { tag: "StatusChanged", value: { messageId: draft.messageId, status } });
    };
    return {
        get text() {
            return current;
        },
        append(chunk) {
            if (!open || chunk.length === 0) return;
            current += chunk;
            edit();
        },
        replace(whole) {
            if (!open) return;
            current = whole;
            edit();
        },
        finish: () => close("Sent"),
        fail: () => close("Failed"),
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { ok } = await import("@parity/product-sdk-host");
    const { ManualClock, settle } = await import("@parity/product-sdk-utils/testing");
    const { FeedSender } = await import("./feed.js");
    const { message } = await import("./builders.js");

    test("a streamed answer is New Preparing, one folded edit, then Sent", async () => {
        const clock = new ManualClock(0);
        const sent: unknown[] = [];
        const feed = new FeedSender(
            {
                async updateFeed(_roomId, update) {
                    sent.push(update);
                    return ok(undefined);
                },
            },
            { clock },
        );
        const answer = streamMessage(
            feed,
            "r",
            message({ messageId: "a", from: "product", timestamp: 0n, body: text("") }),
            { clock },
        );
        answer.append("Hel");
        answer.append("lo");
        answer.finish();
        answer.append(" ignored");
        const done = feed.flushed();
        await settle();
        await clock.advance(1_000);
        await done;
        expect(sent.map((update) => (update as { tag: string }).tag)).toEqual([
            "New",
            "Edited",
            "StatusChanged",
        ]);
        expect(sent[1]).toEqual({
            tag: "Edited",
            value: { messageId: "a", body: text("Hello"), editedAt: 0n },
        });
        expect(answer.text).toBe("Hello");
    });
}
