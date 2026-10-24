// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * How a room appears in the chat list.
 *
 * A product-source room's place in the chat list is as fresh as the product's
 * last `set_room_preview`, because the chat list never starts the worker. The
 * core takes at most 5 previews per second per room, so {@link PreviewScheduler}
 * builds and sends one preview per burst of changes, and {@link buildPreview}
 * turns what the product knows into the preview the RFC describes.
 *
 * @module
 */
import type {
    ChatPreviewReaction,
    ChatRoomMessage,
    ChatRoomPreview,
    ChatRooms,
} from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import { type Clock, systemClock } from "@parity/product-sdk-utils";

import { ROOM_RATES } from "./limits.js";

const log = createLogger("chat:preview");

/** What a product knows about a room's newest events. */
export interface PreviewFacts {
    /** The newest message the user sees. The host makes the preview line from it. */
    newest?: ChatRoomMessage;
    /** Unread messages. Omit to keep the host's own count (a host-store room's default). */
    unread?: number;
    /** The newest reaction change, placed or removed, with its time. */
    reaction?: { reaction: ChatPreviewReaction; at: bigint };
    /** The newest call message, which keeps the time of its offer while it is answered and closed later. */
    newestCall?: ChatRoomMessage;
    /** The contact's reactions the user has not seen. */
    unseenReactions?: number;
}

/**
 * The preview of a room. The newest event orders the room: the newest reaction
 * when it is newer than the newest message, else the newest message. `lastCall` is
 * set only when the newest call is not the newest message, and each host applies
 * its own rule to it.
 */
export function buildPreview(facts: PreviewFacts): ChatRoomPreview {
    const { newest, reaction, newestCall } = facts;
    const reactionIsNewest = reaction !== undefined && (!newest || reaction.at > newest.timestamp);
    const timestamp = reactionIsNewest ? reaction.at : newest?.timestamp;
    return {
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(facts.unread !== undefined
            ? {
                  badge:
                      facts.unread > 0
                          ? { tag: "UnreadCount", value: { count: facts.unread } }
                          : { tag: "Hidden" },
              }
            : {}),
        ...(newest ? { lastMessage: newest } : {}),
        ...(reactionIsNewest ? { lastReaction: reaction.reaction } : {}),
        ...(newestCall && newestCall.messageId !== newest?.messageId
            ? { lastCall: newestCall }
            : {}),
        unseenReactions: facts.unseenReactions ?? 0,
    };
}

/** Options of a {@link PreviewScheduler}. */
export interface PreviewSchedulerOptions {
    clock?: Clock;
    /** Previews per second per room. Default 5, the core's bound. */
    perSecond?: number;
}

/**
 * Sends a room's preview once per burst: the first change waits a fifth of a
 * second, and every change in that time shares the one preview built at its end.
 *
 * @example
 * ```ts
 * const previews = new PreviewScheduler(rooms);
 * previews.schedule("support", async () => buildPreview({ newest: await newestMessage() }));
 * ```
 */
export class PreviewScheduler {
    private readonly pending = new Map<string, Promise<void>>();
    private readonly clock: Clock;
    private readonly spacingMs: number;

    constructor(
        private readonly rooms: Pick<ChatRooms, "setPreview">,
        options: PreviewSchedulerOptions = {},
    ) {
        this.clock = options.clock ?? systemClock;
        this.spacingMs = 1000 / (options.perSecond ?? ROOM_RATES.setPreview);
    }

    /**
     * Sends the preview `build` makes, after the burst. `build` returning
     * `undefined` sends nothing. Resolves when the preview was sent.
     */
    schedule(roomId: string, build: () => Promise<ChatRoomPreview | undefined>): Promise<void> {
        const pending = this.pending.get(roomId);
        if (pending) return pending;
        const next = this.clock.sleep(this.spacingMs).then(async () => {
            this.pending.delete(roomId);
            try {
                const preview = await build();
                if (!preview) return;
                const sent = await this.rooms.setPreview(roomId, preview);
                if (!sent.ok)
                    log.warn(`preview of ${roomId} refused`, { reason: sent.error.message });
            } catch (error) {
                log.warn(`preview of ${roomId} not built`, {
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        });
        this.pending.set(roomId, next);
        return next;
    }

    /** Resolves when every scheduled preview was sent. */
    async flushed(): Promise<void> {
        await Promise.all(this.pending.values());
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;
    const { ok } = await import("@parity/product-sdk-host");
    const { ManualClock } = await import("@parity/product-sdk-utils/testing");

    const message = (messageId: string, timestamp: bigint): ChatRoomMessage => ({
        messageId,
        origin: { participantId: "contact" },
        timestamp,
        body: { tag: "Text", value: { text: messageId } },
        status: "Delivered",
        reactions: [],
        request: false,
    });

    describe("buildPreview", () => {
        test("a newer reaction orders the room and is the preview line", () => {
            const reaction = { reaction: { emoji: "👍", byUser: false, removed: false }, at: 20n };
            expect(buildPreview({ newest: message("m", 10n), reaction, unread: 2 })).toEqual({
                timestamp: 20n,
                badge: { tag: "UnreadCount", value: { count: 2 } },
                lastMessage: message("m", 10n),
                lastReaction: reaction.reaction,
                unseenReactions: 0,
            });
        });

        test("an older reaction is left out, and no unread hides the badge", () => {
            const reaction = { reaction: { emoji: "👍", byUser: true, removed: true }, at: 5n };
            expect(buildPreview({ newest: message("m", 10n), reaction, unread: 0 })).toEqual({
                timestamp: 10n,
                badge: { tag: "Hidden" },
                lastMessage: message("m", 10n),
                unseenReactions: 0,
            });
        });

        test("the newest call is sent only when it is not the newest message", () => {
            const call = message("call", 3n);
            expect(buildPreview({ newest: call, newestCall: call }).lastCall).toBeUndefined();
            expect(buildPreview({ newest: message("m", 9n), newestCall: call }).lastCall).toEqual(
                call,
            );
        });

        test("without an unread count the host keeps its own", () => {
            expect("badge" in buildPreview({ newest: message("m", 1n) })).toBe(false);
        });
    });

    test("a burst of changes sends one preview", async () => {
        const clock = new ManualClock(0);
        const sent: ChatRoomPreview[] = [];
        const previews = new PreviewScheduler(
            {
                async setPreview(_roomId: string, preview: ChatRoomPreview) {
                    sent.push(preview);
                    return ok(undefined);
                },
            },
            { clock },
        );
        let builds = 0;
        const build = async () => {
            builds++;
            return buildPreview({ unseenReactions: builds });
        };
        void previews.schedule("r", build);
        void previews.schedule("r", build);
        await clock.advance(200);
        await previews.flushed();
        expect(sent).toEqual([{ unseenReactions: 1 }]);
    });
}
