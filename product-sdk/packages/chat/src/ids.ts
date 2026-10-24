// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Room ids and participant ids.
 *
 * A room id is the product's own string, scoped to the product by the host. A
 * product with several kinds of room gives each kind a prefix, so a query tells
 * which kind it is about from the room id alone.
 *
 * @module
 */

/**
 * The participant ids the host reserves: its user, the product itself, and the
 * contact of a contact room. Any other id is a participant the product names.
 */
export const PARTICIPANT = {
    user: "user",
    product: "product",
    contact: "contact",
} as const;

/** Maps a product's own key (an account, a channel id) to a room id and back. */
export interface RoomIdCodec {
    /** The room id of `key`. */
    of(key: string): string;
    /** The key of a room id of this kind, or `undefined` for any other room. */
    keyOf(roomId: string): string | undefined;
}

/**
 * Room ids of one kind: `<prefix>-<key>`.
 *
 * @example
 * ```ts
 * const contactRooms = roomIds("dm");
 * contactRooms.of("ab12");        // "dm-ab12"
 * contactRooms.keyOf("dm-ab12");  // "ab12"
 * contactRooms.keyOf("group-7");  // undefined
 * ```
 */
export function roomIds(prefix: string): RoomIdCodec {
    const start = `${prefix}-`;
    return {
        of: (key) => `${start}${key}`,
        keyOf: (roomId) =>
            roomId.startsWith(start) && roomId.length > start.length
                ? roomId.slice(start.length)
                : undefined,
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("a codec maps keys to its own rooms only", () => {
        const rooms = roomIds("dm");
        expect(rooms.of("ab")).toBe("dm-ab");
        expect(rooms.keyOf("dm-ab")).toBe("ab");
        expect(rooms.keyOf("dm-")).toBeUndefined();
        expect(rooms.keyOf("dmx-ab")).toBeUndefined();
    });
}
