// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The decoder against pinned bytes on the RFC's layout, and against the records
// written before it, which must read as no profile. Every vector is a constant
// here, the repo's convention: `src` ships to npm, so there is no fixture
// directory. Index 0's vectors are the core's own (`public_profile/record/tests.rs`);
// the `Name` and `Feed` vectors are what the first publisher of each kind wrote.
import { describe, expect, test } from "vitest";
import {
    profileAvatarCodec,
    profileFeedCodec,
    profileNameCodec,
    profileRecordCodec,
} from "./codec.js";
import { decodeBase64Strict, decodeProfileRecord, decodeRecordEntries } from "./record.js";
import { PROFILE_ENTRY_INDEX, PROFILE_RECORD_MAX_BYTES } from "./types.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** One entry as the wrapper carries it: the variant index, then the payload. */
const entry = (index: number, payload: Uint8Array) => new Uint8Array([index, ...payload]);
/** A record from its entries, base64, as the text record carries it. */
const record = (entries: Uint8Array[]) => base64(profileRecordCodec.enc(entries));

// The CID and digest the core's own record tests use (`public_profile/record/tests.rs`).
const CID = "bafk2bzaceaf5do2x4p46vaazk2txb7qqnd4vaobvi6wkixq5hu2u2v6qctfqy";
const DIGEST = "0x0bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c" as const;
const avatar = (digest: `0x${string}`, format: number) =>
    profileAvatarCodec.enc({ cid: digest, format });
const name = (text: string) => profileNameCodec.enc(utf8(text));
const TOPIC = `0x${"11".repeat(32)}` as const;
const SIGNER = `0x${"22".repeat(32)}` as const;

// { Avatar(CID, webp), Name("Alice") }: compact(2); then each entry as a
// length-prefixed byte string, index byte first. The avatar entry is 34 bytes
// (index, the 32-byte digest, the format), so its prefix is compact(34), 0x88;
// the name entry is 7 (index, compact(5), "Alice").
const VECTOR_HEX =
    "0888000bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c021c0114416c696365";
const VECTOR_BASE64 = "CIgAC9G7V+P56oAZVqdw/hBo+VA4NUespF4dPTVNV9AUywwCHAEUQWxpY2U=";

// Records written before the RFC moved to codec indices (`Vec<{ kind: String,
// payload: Vec<u8> }>`), both published on Paseo for devdevdev.01.paseo.
// Neither is a profile any more; the next publish replaces them.
const PRE_RFC_CURRENT =
    "CBhhdmF0YXIBAfhiYWZrMmJ6YWNlYnRtdW41Znk2NjNkdmZ3eWMzMzZjeHdkbGhtc2VraTNtanNlazZ3bXN5Z3R2ZjJuYjRlZwIQbmFtZRhkZXZkZXY=";
const PRE_RFC_OLD =
    "CBhhdmF0YXL4YmFmazJiemFjZWNpYWx4dWlnb2Y3cmlrNnh6ZWN1d21wZ2RvZDNoYWVmMnB1dzZ5YWJtYndra3lsZ2tlN3EQbmFtZRhkZXZkZXY=";
// The string-kind vector the pre-RFC Rust pinned, for the same reason.
const PRE_RFC_RUST_VECTOR_HEX =
    "08186176617461720101f86261666b32627a616365637632786b356c766f7632786b356c766f7632786b356c766f7632786b356c766f7632786b356c766f7632786b356c766f76327702106e616d6514416c696365";

/**
 * A pin as test records on Paseo wrote it under index 2, before the
 * index was reserved with no payload: instance 2^40 + 7, collection 3, item
 * 258, a purse of 0xab bytes. Raw bytes, not a codec, since none is defined.
 */
const LEGACY_PIN = entry(2, hex(`07000000000100000300000002010000${"ab".repeat(32)}`));

function unwrap(text: string) {
    const r = decodeProfileRecord(text);
    if (!r.ok) throw r.error;
    return r.value;
}

function reason(text: string) {
    const r = decodeProfileRecord(text);
    return r.ok ? "ok" : r.error.reason;
}

describe("decodeBase64Strict", () => {
    test("decodes standard base64 with padding", () => {
        expect(decodeBase64Strict(VECTOR_BASE64)).toEqual(hex(VECTOR_HEX));
        expect(decodeBase64Strict("")).toEqual(new Uint8Array());
        expect(decodeBase64Strict("QQ==")).toEqual(utf8("A"));
    });

    test("refuses non-canonical base64", () => {
        expect(decodeBase64Strict("QQ=")).toBeNull(); // not a multiple of four
        expect(decodeBase64Strict("QQ")).toBeNull();
        expect(decodeBase64Strict("Q===")).toBeNull(); // three padding characters
        expect(decodeBase64Strict("QR==")).toBeNull(); // leftover bits set
        expect(decodeBase64Strict("QQ-_")).toBeNull(); // the URL alphabet
        expect(decodeBase64Strict("not base64!")).toBeNull();
    });
});

describe("decodeProfileRecord", () => {
    test("pins the bytes of the RFC layout and decodes them", () => {
        const encoded = profileRecordCodec.enc([
            entry(PROFILE_ENTRY_INDEX.avatar, avatar(DIGEST, 2)),
            entry(PROFILE_ENTRY_INDEX.name, name("Alice")),
        ]);
        expect(toHex(encoded)).toBe(VECTOR_HEX);
        expect(base64(encoded)).toBe(VECTOR_BASE64);
        expect(unwrap(VECTOR_BASE64)).toEqual({
            avatar: { cid: CID, format: "webp" },
            name: "Alice",
            feeds: [],
            unknown: [],
        });
    });

    test("decodes the core's vectors: the digest and each format, and an unknown kind kept in place", () => {
        // From the core's `public_profile/record/tests.rs`: the same CID in
        // each of the four formats, a record that round-trips byte for byte.
        const formats = ["png", "jpeg", "webp", "gif"] as const;
        for (const [i, format] of formats.entries()) {
            const text = `BIgAC9G7V+P56oAZVqdw/hBo+VA4NUespF4dPTVNV9AUyww${"ABCD"[i]}`;
            expect(unwrap(text)).toEqual({
                avatar: { cid: CID, format },
                name: null,
                feeds: [],
                unknown: [],
            });
            const entries = decodeRecordEntries(text);
            expect(entries.ok && base64(profileRecordCodec.enc(entries.value))).toBe(text);
        }
        // An entry of a kind this reader does not know, then the avatar.
        const wire =
            "080807aa88000bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c00";
        const profile = unwrap(base64(hex(wire)));
        expect(profile.avatar).toEqual({ cid: CID, format: "png" });
        expect(profile.unknown).toEqual([{ bytes: new Uint8Array([7, 0xaa]) }]);
        // An avatar entry a newer writer extended by a byte is kept, and is no avatar.
        const extended =
            "048c000bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c00aa";
        const read = unwrap(base64(hex(extended)));
        expect(read.avatar).toBeNull();
        expect(read.unknown).toEqual([{ bytes: hex(extended).subarray(2) }]);
    });

    test("index 2 is reserved with no payload: a legacy test pin is kept as unknown, in place", () => {
        expect(PROFILE_ENTRY_INDEX.nft).toBe(2);
        expect(LEGACY_PIN).toHaveLength(49);
        const profile = unwrap(
            record([
                LEGACY_PIN,
                entry(PROFILE_ENTRY_INDEX.name, name("Alice")),
                entry(2, new Uint8Array()),
            ]),
        );
        expect(profile.name).toBe("Alice");
        expect(profile.unknown).toEqual([
            { bytes: LEGACY_PIN },
            { bytes: entry(2, new Uint8Array()) },
        ]);
    });

    test("pins the feed payload: (kind String, topic [u8; 32], signer [u8; 32])", () => {
        const feed = { kind: "mood", topic: TOPIC, signer: SIGNER };
        const encoded = profileFeedCodec.enc({ ...feed, kind: utf8(feed.kind) });
        expect(toHex(encoded)).toBe(`106d6f6f64${"11".repeat(32)}${"22".repeat(32)}`);
        expect(unwrap(record([entry(PROFILE_ENTRY_INDEX.feed, encoded)])).feeds).toEqual([feed]);
    });

    test("an avatar in an unknown format keeps the entry, and the next avatar wins", () => {
        const odd = entry(PROFILE_ENTRY_INDEX.avatar, avatar(DIGEST, 9));
        const profile = unwrap(record([odd, entry(PROFILE_ENTRY_INDEX.avatar, avatar(DIGEST, 1))]));
        expect(profile.avatar).toEqual({ cid: CID, format: "jpeg" });
        expect(profile.unknown).toEqual([{ bytes: odd }]);
    });

    test("an avatar payload that is not one digest and a format is kept as unknown", () => {
        // The core's `an_incomplete_avatar_is_preserved_and_skipped`: no bytes,
        // a short digest, a digest with no format; and one byte too many.
        const incomplete = [0, 31, 32].map((length) =>
            entry(PROFILE_ENTRY_INDEX.avatar, new Uint8Array(length)),
        );
        const trailing = entry(
            PROFILE_ENTRY_INDEX.avatar,
            new Uint8Array([...avatar(DIGEST, 2), 0]),
        );
        const profile = unwrap(record([...incomplete, trailing]));
        expect(profile.avatar).toBeNull();
        expect(profile.unknown).toEqual([...incomplete, trailing].map((bytes) => ({ bytes })));
    });

    test("the first non-empty name of at most 64 bytes wins; an empty or longer one is known and ignored", () => {
        const profile = unwrap(
            record([
                entry(PROFILE_ENTRY_INDEX.name, name("")),
                entry(PROFILE_ENTRY_INDEX.name, name("x".repeat(65))),
                entry(PROFILE_ENTRY_INDEX.name, name("é".repeat(32))),
                entry(PROFILE_ENTRY_INDEX.name, name("Second")),
            ]),
        );
        expect(profile.name).toBe("é".repeat(32));
        expect(profile.unknown).toEqual([]);
    });

    test("a name that is not UTF-8, or has trailing bytes, is kept as unknown", () => {
        const notUtf8 = entry(
            PROFILE_ENTRY_INDEX.name,
            profileNameCodec.enc(new Uint8Array(70).fill(0xff)),
        );
        const trailing = entry(PROFILE_ENTRY_INDEX.name, new Uint8Array([...name("A"), 0]));
        // A SCALE String carries its own length: bare bytes, the pre-RFC form, are not one.
        const bare = entry(PROFILE_ENTRY_INDEX.name, utf8("Alice"));
        const profile = unwrap(record([notUtf8, trailing, bare]));
        expect(profile.name).toBeNull();
        expect(profile.unknown).toEqual([{ bytes: notUtf8 }, { bytes: trailing }, { bytes: bare }]);
    });

    test("a leading byte-order mark is part of the name and counts toward the bound, as in Rust", () => {
        const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
        const short = profileNameCodec.enc(new Uint8Array([...bom, ...utf8("A")]));
        expect(unwrap(record([entry(PROFILE_ENTRY_INDEX.name, short)])).name).toBe("﻿A");
        // 62 ASCII bytes behind the mark is 65 bytes: over the bound, so no name.
        const long = profileNameCodec.enc(
            new Uint8Array([...bom, ...new Uint8Array(62).fill(0x41)]),
        );
        expect(unwrap(record([entry(PROFILE_ENTRY_INDEX.name, long)])).name).toBeNull();
    });

    test("an entry with an unknown index is kept in place, and the first valid of a kind wins", () => {
        const future = entry(9, new Uint8Array([1, 2, 3]));
        const profile = unwrap(
            record([
                future,
                entry(PROFILE_ENTRY_INDEX.avatar, utf8("not a tuple")),
                entry(PROFILE_ENTRY_INDEX.avatar, avatar(DIGEST, 1)),
                entry(PROFILE_ENTRY_INDEX.name, name("First")),
                entry(PROFILE_ENTRY_INDEX.name, name("Second")),
            ]),
        );
        expect(profile.avatar).toEqual({ cid: CID, format: "jpeg" });
        expect(profile.name).toBe("First");
        expect(profile.unknown).toEqual([
            { bytes: future },
            { bytes: entry(PROFILE_ENTRY_INDEX.avatar, utf8("not a tuple")) },
        ]);
    });

    test("an empty entry has no index and is kept as unknown", () => {
        const empty = new Uint8Array(0);
        expect(unwrap(record([empty])).unknown).toEqual([{ bytes: empty }]);
    });

    test("every feed that decodes is kept in order; one that does not is unknown", () => {
        const feed = (kind: string) =>
            profileFeedCodec.enc({ kind: utf8(kind), topic: TOPIC, signer: SIGNER });
        const longFeed = entry(PROFILE_ENTRY_INDEX.feed, new Uint8Array([...feed("mood"), 0]));
        const profile = unwrap(
            record([
                entry(PROFILE_ENTRY_INDEX.feed, feed("mood")),
                longFeed,
                entry(PROFILE_ENTRY_INDEX.feed, feed("status")),
            ]),
        );
        expect(profile.feeds).toEqual([
            { kind: "mood", topic: TOPIC, signer: SIGNER },
            { kind: "status", topic: TOPIC, signer: SIGNER },
        ]);
        expect(profile.unknown).toEqual([{ bytes: longFeed }]);
    });

    test("refuses what is not a record", () => {
        const vector = hex(VECTOR_HEX);
        expect(reason(base64(new Uint8Array([...vector, 0])))).toBe("Malformed"); // trailing byte
        expect(reason(base64(vector.subarray(0, vector.length - 1)))).toBe("Malformed"); // truncated
        expect(reason(base64(new Uint8Array()))).toBe("Malformed"); // empty
        expect(reason("not base64!")).toBe("NotBase64");
        expect(reason("QQ=")).toBe("NotBase64");
        const big = profileRecordCodec.enc([entry(9, new Uint8Array(PROFILE_RECORD_MAX_BYTES))]);
        expect(big.length).toBeGreaterThan(PROFILE_RECORD_MAX_BYTES);
        expect(reason(base64(big))).toBe("TooLarge");
    });

    test("refuses a non-minimal compact length in the envelope, as parity-scale-codec does", () => {
        const nameEntry = entry(PROFILE_ENTRY_INDEX.name, name("A"));
        // The entry count 1 in the two-byte form, 0x05 0x00, instead of 0x04.
        const count = new Uint8Array([0x05, 0x00, nameEntry.length << 2, ...nameEntry]);
        expect(reason(base64(count))).toBe("Malformed");
        // The entry's own length prefix in the two-byte form.
        const length = new Uint8Array([
            0x04,
            ((nameEntry.length << 2) | 1) & 0xff,
            0x00,
            ...nameEntry,
        ]);
        expect(reason(base64(length))).toBe("Malformed");
        // Inside a payload it makes that entry unknown, never fatal.
        const inner = entry(PROFILE_ENTRY_INDEX.name, new Uint8Array([0x05, 0x00, 0x41]));
        expect(unwrap(record([inner])).unknown).toEqual([{ bytes: inner }]);
    });

    test("a record in the layout that preceded the RFC is not a profile", () => {
        expect(reason(PRE_RFC_CURRENT)).toBe("Malformed");
        expect(reason(PRE_RFC_OLD)).toBe("Malformed");
        expect(reason(base64(hex(PRE_RFC_RUST_VECTOR_HEX)))).toBe("Malformed");
    });

    test("exactly 16 KiB is still a record", () => {
        // One entry: a one-byte count, a two-byte length prefix, the index byte
        // and the payload.
        const encoded = profileRecordCodec.enc([
            entry(9, new Uint8Array(PROFILE_RECORD_MAX_BYTES - 4)),
        ]);
        expect(encoded.length).toBe(PROFILE_RECORD_MAX_BYTES);
        expect(reason(base64(encoded))).toBe("ok");
    });
});
