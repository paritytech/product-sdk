// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The decoder against the bytes the core's encoder pins, and against the two
// real records Seity wrote on Paseo Next. Every vector is a constant here, the
// repo's convention: `src` ships to npm, so there is no fixture directory.
import { describe, expect, test } from "vitest";

import {
    profileAvatarCodec,
    profileFeedCodec,
    profileNftCodec,
    profileRecordCodec,
} from "./codec.js";
import { decodeBase64Strict, decodeProfileRecord } from "./record.js";
import { PROFILE_RECORD_MAX_BYTES } from "./types.js";

// `profile.rs` `VECTOR_HEX`: { avatar: (CID, webp), name: "Alice" }, where the
// CID is raw/blake2b-256 of 0xab × 32.
const RUST_VECTOR_HEX =
    "08186176617461720101f86261666b32627a616365637632786b356c766f7632786b356c766f7632786b356c766f7632786b356c766f7632786b356c766f7632786b356c766f76327702106e616d6514416c696365";
// `runtime/public_profile.rs` `VECTOR_BASE64`: the same record, as the text record carries it.
const RUST_VECTOR_BASE64 =
    "CBhhdmF0YXIBAfhiYWZrMmJ6YWNlY3YyeGs1bHZvdjJ4azVsdm92MnhrNWx2b3YyeGs1bHZvdjJ4azVsdm92MnhrNWx2b3YydwIQbmFtZRRBbGljZQ==";
const RUST_VECTOR_CID = "bafk2bzacecv2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2w";

// devdevdev.01.paseo, written after Seity PR 28: avatar (cid, webp) + name "devdev"; 86 bytes.
const REAL_CURRENT =
    "CBhhdmF0YXIBAfhiYWZrMmJ6YWNlYnRtdW41Znk2NjNkdmZ3eWMzMzZjeHdkbGhtc2VraTNtanNlazZ3bXN5Z3R2ZjJuYjRlZwIQbmFtZRhkZXZkZXY=";
const REAL_CURRENT_CID = "bafk2bzacebtmun5fy663dvfwyc336cxwdlhmseki3mjsek6wmsygtvf2nb4eg";
// The same name before PR 28: the avatar payload is the bare CID string; 83 bytes.
const REAL_OLD =
    "CBhhdmF0YXL4YmFmazJiemFjZWNpYWx4dWlnb2Y3cmlrNnh6ZWN1d21wZ2RvZDNoYWVmMnB1dzZ5YWJtYndra3lsZ2tlN3EQbmFtZRhkZXZkZXY=";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Encode a record from `[kind, payload]` pairs, as the writer does. */
function record(entries: Array<[string, Uint8Array]>): Uint8Array {
    return profileRecordCodec.enc({
        entries: entries.map(([kind, payload]) => ({ kind: utf8(kind), payload })),
    });
}

const avatar = (cid: string, format: number) => profileAvatarCodec.enc({ cid: utf8(cid), format });
const PURSE = `0x${"ab".repeat(32)}` as const;
const TOPIC = `0x${"01".repeat(32)}` as const;
const SIGNER = `0x${"02".repeat(32)}` as const;

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
        expect(decodeBase64Strict(RUST_VECTOR_BASE64)).toEqual(hex(RUST_VECTOR_HEX));
        expect(decodeBase64Strict("")).toEqual(new Uint8Array());
        expect(decodeBase64Strict("QQ==")).toEqual(utf8("A"));
    });

    test("refuses what the core refuses", () => {
        expect(decodeBase64Strict("QQ=")).toBeNull(); // not a multiple of four
        expect(decodeBase64Strict("QQ")).toBeNull();
        expect(decodeBase64Strict("Q===")).toBeNull(); // three padding characters
        expect(decodeBase64Strict("QR==")).toBeNull(); // leftover bits set
        expect(decodeBase64Strict("QQ-_")).toBeNull(); // the URL alphabet
        expect(decodeBase64Strict("not base64!")).toBeNull();
    });
});

describe("decodeProfileRecord", () => {
    test("decodes the bytes the core's writer pins", () => {
        const profile = unwrap(RUST_VECTOR_BASE64);
        expect(profile).toEqual({
            avatar: { cid: RUST_VECTOR_CID, format: "webp" },
            name: "Alice",
            nfts: [],
            feeds: [],
            unknown: [],
        });
        expect(base64(hex(RUST_VECTOR_HEX))).toBe(RUST_VECTOR_BASE64);
    });

    test("reads the real record in its current shape", () => {
        const profile = unwrap(REAL_CURRENT);
        expect(profile.avatar).toEqual({ cid: REAL_CURRENT_CID, format: "webp" });
        expect(profile.name).toBe("devdev");
    });

    test("reads the real record in its old shape as having no avatar", () => {
        // The payload is the bare CID string. Read as a `(cid, format)` tuple, its
        // first byte is a compact length far past the payload, so it is malformed
        // and skipped. No fallback: the writer moved on, and so does the reader.
        const profile = unwrap(REAL_OLD);
        expect(profile.avatar).toBeNull();
        expect(profile.name).toBe("devdev");
        expect(profile.unknown).toEqual([]);
    });

    test("maps every format index, and an unknown one to no avatar", () => {
        expect(
            unwrap(base64(record([["avatar", avatar(RUST_VECTOR_CID, 0)]]))).avatar?.format,
        ).toBe("png");
        expect(
            unwrap(base64(record([["avatar", avatar(RUST_VECTOR_CID, 1)]]))).avatar?.format,
        ).toBe("jpeg");
        expect(
            unwrap(base64(record([["avatar", avatar(RUST_VECTOR_CID, 2)]]))).avatar?.format,
        ).toBe("webp");
        const unknown = unwrap(
            base64(
                record([
                    ["avatar", avatar(RUST_VECTOR_CID, 9)],
                    ["name", utf8("A")],
                ]),
            ),
        );
        expect(unknown.avatar).toBeNull();
        expect(unknown.name).toBe("A");
    });

    test("an avatar payload with trailing bytes, or a non-UTF-8 CID, is no avatar", () => {
        const trailing = new Uint8Array([...avatar(RUST_VECTOR_CID, 2), 0]);
        expect(unwrap(base64(record([["avatar", trailing]]))).avatar).toBeNull();
        const badCid = profileAvatarCodec.enc({ cid: new Uint8Array([0xff, 0xfe]), format: 2 });
        expect(unwrap(base64(record([["avatar", badCid]]))).avatar).toBeNull();
    });

    test("a name over 64 bytes or not UTF-8 is no name; 64 bytes of UTF-8 is", () => {
        expect(unwrap(base64(record([["name", new Uint8Array(65).fill(0x78)]]))).name).toBeNull();
        expect(unwrap(base64(record([["name", new Uint8Array([0xff, 0xfe])]]))).name).toBeNull();
        expect(unwrap(base64(record([["name", utf8("é".repeat(32))]]))).name).toBe("é".repeat(32));
    });

    test("unknown kinds are kept and the first valid of a kind wins", () => {
        const second = avatar(RUST_VECTOR_CID, 1);
        const profile = unwrap(
            base64(
                record([
                    ["mood", new Uint8Array([1, 2, 3])],
                    ["avatar", utf8("not a tuple")],
                    ["avatar", second],
                    ["name", utf8("First")],
                    ["name", utf8("Second")],
                ]),
            ),
        );
        expect(profile.avatar).toEqual({ cid: RUST_VECTOR_CID, format: "jpeg" });
        expect(profile.name).toBe("First");
        expect(profile.unknown).toEqual([{ kind: "mood", payload: new Uint8Array([1, 2, 3]) }]);
    });

    test("every nft and feed that decodes is kept in order; a malformed one is skipped", () => {
        const nft = (instance: bigint, collection: number, item: number) =>
            profileNftCodec.enc({ instance, collection, item, purse: PURSE });
        const feed = profileFeedCodec.enc({ kind: utf8("mood"), topic: TOPIC, signer: SIGNER });
        const profile = unwrap(
            base64(
                record([
                    ["nft", nft(7n, 3, 9)],
                    ["nft", new Uint8Array([1, 2, 3])],
                    ["nft", nft(2n ** 64n - 1n, 0, 0)],
                    ["feed", feed],
                    ["feed", new Uint8Array([...feed, 0])],
                ]),
            ),
        );
        expect(profile.nfts).toEqual([
            { instance: 7n, collection: 3, item: 9, purse: PURSE },
            { instance: 2n ** 64n - 1n, collection: 0, item: 0, purse: PURSE },
        ]);
        expect(profile.feeds).toEqual([{ kind: "mood", topic: TOPIC, signer: SIGNER }]);
    });

    test("refuses what is not a record", () => {
        const vector = hex(RUST_VECTOR_HEX);
        expect(reason(base64(new Uint8Array([...vector, 0])))).toBe("Malformed"); // trailing byte
        expect(reason(base64(vector.subarray(0, vector.length - 1)))).toBe("Malformed"); // truncated
        expect(reason(base64(new Uint8Array()))).toBe("Malformed"); // empty
        expect(reason("not base64!")).toBe("NotBase64");
        expect(reason("QQ=")).toBe("NotBase64");
        const big = record([["x", new Uint8Array(PROFILE_RECORD_MAX_BYTES)]]);
        expect(big.length).toBeGreaterThan(PROFILE_RECORD_MAX_BYTES);
        expect(reason(base64(big))).toBe("TooLarge");
        // A kind that is not UTF-8 fails the core's `String` decode, so the whole
        // record is malformed rather than an unknown kind.
        const badKind = profileRecordCodec.enc({
            entries: [{ kind: new Uint8Array([0xff]), payload: new Uint8Array() }],
        });
        expect(reason(base64(badKind))).toBe("Malformed");
    });

    test("exactly 16 KiB is still a record", () => {
        // One entry: a one-byte entry count, a one-byte kind length plus "x",
        // a two-byte payload length, and the payload.
        const encoded = record([["x", new Uint8Array(PROFILE_RECORD_MAX_BYTES - 5)]]);
        expect(encoded.length).toBe(PROFILE_RECORD_MAX_BYTES);
        expect(reason(base64(encoded))).toBe("ok");
    });
});
