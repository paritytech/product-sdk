// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Scarcity metadata: untyped bytes on chain, a string bag here.
 *
 * `Scarcity` stores metadata as `Vec<u8>` → `Vec<u8>` across three layers, each
 * overriding the last for the same key:
 *
 * ```
 * CollectionMetadata  (u32, key)            collection-wide defaults
 * ItemMetadata        (u32, u32, key)       per-item override
 * InstanceMetadata    (u64, key)            per-instance override
 * ```
 *
 * A catalogue read merges the first two. The third keys on an instance id rather
 * than an item, so it belongs to a read of what someone owns, not to a
 * catalogue — {@link mergeMetadata} takes layers in order and does not care how
 * many there are.
 *
 * Nothing on chain declares the key vocabulary or the value types, so decoding
 * is a convention rather than a codec. That convention is
 * {@link decodeMetadataValue}, and it is deliberately lossless-ish: text when
 * the bytes are text, hex when they are not, and never a guess at a number.
 *
 * `image` is the one key read both ways ({@link imageRefFrom}). Deployments
 * disagree on whether it holds a content digest or an ASCII CID, and a reader
 * that guessed would be wrong on one of them.
 */
import { NftsDecodeError } from "./errors.js";
import type { ImageRef, RawBytes } from "./types.js";

const HEX = "0123456789abcdef";

/**
 * The `name` metadata key as bytes, encoded once.
 *
 * Exact-key reads take the key as a plain `Uint8Array`, so a paged read builds
 * this once rather than per collection per page.
 */
export const NAME_KEY: Uint8Array = new TextEncoder().encode("name");

/**
 * The metadata keys a paged read can fetch by exact key.
 *
 * The three the typed fields come from. Encoded once, since a page asks for all
 * of them for every item in its window.
 *
 * This is the whole of what a page can resolve without a prefix scan: the open
 * bag on {@link CollectionItem.attributes} has no fixed key list to ask for, so
 * these are the fields a page carries. They are a convention rather than a
 * schema — see the module doc — which is exactly why the bag exists as well.
 */
export const TYPED_KEYS = {
    name: NAME_KEY,
    image: new TextEncoder().encode("image"),
    rarity: new TextEncoder().encode("rarity"),
} as const;

/**
 * Reused across entries: a whole-map metadata dump decodes one key per row, and
 * a fresh `TextDecoder` per row is pure allocation. Stateless for non-streaming
 * `decode` calls, so sharing it is safe.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Accepts either PAPI shape for a byte string. */
export function toBytes(raw: RawBytes): Uint8Array {
    if (raw instanceof Uint8Array) return raw;
    if (typeof (raw as { asBytes?: unknown })?.asBytes === "function") {
        return (raw as { asBytes(): Uint8Array }).asBytes();
    }
    throw new NftsDecodeError("metadata entry is neither raw bytes nor a Binary wrapper");
}

export function toHex(bytes: Uint8Array): string {
    let hex = "0x";
    for (const byte of bytes) {
        hex += HEX[byte >> 4] + HEX[byte & 0x0f];
    }
    return hex;
}

/**
 * Is this decoded string safe to hand a UI as text?
 *
 * `TextDecoder` with `fatal` already rejects invalid UTF-8, but valid UTF-8 is
 * not the same as readable: a digest can decode cleanly and still be control
 * characters. Anything below U+0020 that is not tab/newline/carriage-return
 * disqualifies it, as does a lone U+FFFD.
 */
function isText(decoded: string): boolean {
    for (const char of decoded) {
        const code = char.codePointAt(0) as number;
        if (code === 0xfffd) return false;
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
        if (code === 0x7f) return false;
    }
    return true;
}

/**
 * The bytes as UTF-8 when they are readable text, `null` when they are not.
 *
 * The single place the text/bytes question is answered, so
 * {@link decodeMetadataValue} and {@link imageRefFrom} cannot disagree about
 * what counts as text.
 */
export function asText(bytes: Uint8Array): string | null {
    try {
        const decoded = UTF8.decode(bytes);
        return isText(decoded) ? decoded : null;
    } catch {
        return null;
    }
}

/**
 * Decode one metadata value: UTF-8 when the bytes are readable text, `0x`-hex
 * otherwise.
 *
 * The same heuristic `dot inspect --dump` shows a human, chosen so a caller
 * reading `name` gets `"Hollow Beacon #0"` and one reading `image` gets a hex
 * digest, without the pallet having to declare which is which.
 *
 * Numbers are never parsed, and nothing is lost by that. The live chain's
 * `energy` holds the two ASCII characters `2` and `1` — the chain stored text
 * there, not a binary number — so a value that looks numeric really is text.
 */
export function decodeMetadataValue(raw: RawBytes): string {
    const bytes = toBytes(raw);
    return asText(bytes) ?? toHex(bytes);
}

/** Decode a metadata *key*, which is always text in practice but need not be. */
export function decodeMetadataKey(raw: RawBytes): string {
    return decodeMetadataValue(raw);
}

/**
 * Merge metadata layers, later layers overriding earlier ones per key.
 *
 * Given `[collectionDefaults, itemOverrides]` the item wins, which is what
 * `ItemMetadata`'s "override collection defaults for the same key" means.
 *
 * Internal, and variadic anyway: the catalogue read only ever passes two
 * layers, but the pallet has three, so a future read of `InstanceMetadata`
 * composes here rather than growing a second merge with its own precedence.
 * Not exported — one `Object.assign` is not worth a semver commitment, and
 * unexporting later would be a breaking change where exporting later is not.
 */
export function mergeMetadata(...layers: Array<Record<string, string>>): Record<string, string> {
    // Prototype-free for the same reason the layers are: `Object.assign` assigns,
    // so a `__proto__` key would reach the target's setter rather than land as a
    // key of the merged bag.
    return Object.assign(Object.create(null), ...layers);
}

/**
 * The `image` key, read as both hex and text.
 *
 * Read straight from the bytes rather than out of the merged bag, which holds
 * one reading or the other. Deployments differ on what they put here, so the
 * caller decides which field to display.
 */
export function imageRefFrom(layers: Array<Record<string, RawBytes>>): ImageRef | null {
    for (const layer of layers.slice().reverse()) {
        const raw = layer.image;
        if (raw !== undefined) {
            const bytes = toBytes(raw);
            return { hex: toHex(bytes), text: asText(bytes) };
        }
    }
    return null;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const bytes = (...values: number[]) => new Uint8Array(values);
    const utf8 = (text: string) => new TextEncoder().encode(text);
    const wrapped = (inner: Uint8Array) => ({ asBytes: () => inner });

    describe("toBytes", () => {
        test("passes a Uint8Array through", () => {
            const raw = bytes(1, 2, 3);
            expect(toBytes(raw)).toBe(raw);
        });

        test("unwraps a Binary", () => {
            expect(toBytes(wrapped(bytes(1, 2)))).toEqual(bytes(1, 2));
        });

        test("rejects anything else", () => {
            expect(() => toBytes("0xdead" as unknown as RawBytes)).toThrow(NftsDecodeError);
        });
    });

    describe("toHex", () => {
        test("pads each byte to two digits", () => {
            expect(toHex(bytes(0, 15, 16, 255))).toBe("0x000f10ff");
        });

        test("empty bytes are just the prefix", () => {
            expect(toHex(bytes())).toBe("0x");
        });
    });

    describe("asText", () => {
        test("readable UTF-8 comes back as text", () => {
            expect(asText(utf8("moss"))).toBe("moss");
        });

        test("a 32-byte digest is not text", () => {
            expect(asText(new Uint8Array(32).fill(0xab))).toBeNull();
        });

        test("invalid UTF-8 is not text", () => {
            expect(asText(bytes(0xff, 0xfe))).toBeNull();
        });

        test("valid UTF-8 that is control characters is not text", () => {
            expect(asText(bytes(0x00, 0x01, 0x02))).toBeNull();
        });
    });

    describe("decodeMetadataValue", () => {
        // The six keys the one live item on Paseo Next actually carries.
        test("decodes the live item's text values as text", () => {
            expect(decodeMetadataValue(utf8("Hollow Beacon #0"))).toBe("Hollow Beacon #0");
            expect(decodeMetadataValue(utf8("moss"))).toBe("moss");
            expect(decodeMetadataValue(utf8("comets"))).toBe("comets");
            expect(decodeMetadataValue(utf8("common"))).toBe("common");
        });

        test("a numeric-looking value stays text", () => {
            // The live chain stores `energy` as the ASCII characters "2"
            // and "1": text, not a binary number.
            expect(decodeMetadataValue(utf8("21"))).toBe("21");
        });

        test("the live item's 32-byte image digest falls back to hex", () => {
            const digest = new Uint8Array(32);
            digest.set([0x36, 0xa5, 0xe4, 0xac, 0xc8, 0x18, 0x4d, 0x76]);
            expect(decodeMetadataValue(digest)).toBe(toHex(digest));
        });

        test("invalid UTF-8 falls back to hex", () => {
            expect(decodeMetadataValue(bytes(0xff, 0xfe))).toBe("0xfffe");
        });

        test("valid UTF-8 that is control characters falls back to hex", () => {
            // The case `fatal: true` alone would let through.
            expect(decodeMetadataValue(bytes(0x00, 0x01, 0x02))).toBe("0x000102");
        });

        test("keeps tabs and newlines as text", () => {
            expect(decodeMetadataValue(utf8("a\tb\nc"))).toBe("a\tb\nc");
        });

        test("keeps non-ASCII text as text", () => {
            expect(decodeMetadataValue(utf8("Beacon ✦ 日本"))).toBe("Beacon ✦ 日本");
        });

        test("unwraps a Binary before deciding", () => {
            expect(decodeMetadataValue(wrapped(utf8("moss")))).toBe("moss");
        });
    });

    describe("mergeMetadata", () => {
        test("later layers override earlier ones", () => {
            expect(
                mergeMetadata({ name: "collection", rarity: "common" }, { name: "item" }),
            ).toEqual({ name: "item", rarity: "common" });
        });

        test("no layers is an empty bag", () => {
            expect(mergeMetadata()).toEqual({});
        });
    });

    describe("imageRefFrom", () => {
        const digest = new Uint8Array(32).fill(0xab);
        // An ASCII CID, the other thing a deployment puts in `image`.
        const cid = "bafk2bzacecjsmkthqc5ouon34ql5utgn4qfwwt23b3j5lry5d236nve27xe7m";

        test("prefers the last layer that sets it", () => {
            expect(
                imageRefFrom([{ image: new Uint8Array(32).fill(1) }, { image: digest }]),
            ).toEqual({ hex: toHex(digest), text: null });
        });

        test("falls back to an earlier layer", () => {
            expect(imageRefFrom([{ image: digest }, { name: utf8("x") }])).toEqual({
                hex: toHex(digest),
                text: null,
            });
        });

        test("null when no layer sets it", () => {
            expect(imageRefFrom([{ name: utf8("x") }, {}])).toBeNull();
        });

        test("a digest reports hex and no text", () => {
            expect(imageRefFrom([{ image: digest }])).toEqual({ hex: toHex(digest), text: null });
        });

        test("an ASCII CID reports both readings", () => {
            expect(imageRefFrom([{ image: utf8(cid) }])).toEqual({
                hex: toHex(utf8(cid)),
                text: cid,
            });
        });
    });
}
