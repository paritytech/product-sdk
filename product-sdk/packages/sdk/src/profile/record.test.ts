// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The decoder against pinned bytes on the RFC's layout, and against the records
// written before it, which must read as no profile. Every vector is a constant
// here, the repo's convention: `src` ships to npm, so there is no fixture
// directory. The avatar vectors are the core's own (`public_profile/record/tests.rs`).
import { describe, expect, test } from "vitest";
import { profileAvatarCodec, profileRecordCodec } from "./codec.js";
import { decodeBase64Strict, decodeProfileRecord, decodeRecordEntries } from "./record.js";
import { PROFILE_AVATAR_ENTRY_INDEX, PROFILE_RECORD_MAX_BYTES } from "./types.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** One entry as the wrapper carries it: the variant index, then the payload. */
const entry = (index: number, payload: Uint8Array) => new Uint8Array([index, ...payload]);
/** A record from its entries, base64, as the text record carries it. */
const record = (entries: Uint8Array[]) => base64(profileRecordCodec.enc(entries));

// The CID and digest the core's own record tests use.
const CID = "bafk2bzaceaf5do2x4p46vaazk2txb7qqnd4vaobvi6wkixq5hu2u2v6qctfqy";
const DIGEST = "0x0bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c" as const;
const avatar = (format: number) =>
    entry(PROFILE_AVATAR_ENTRY_INDEX, profileAvatarCodec.enc({ cid: DIGEST, format }));

// The core's `the_wire_record_preserves_length_prefixed_entries`: an entry of
// a kind this reader does not know, then a png avatar.
const WIRE_HEX = "080807aa88000bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c00";

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

function avatarOf(text: string) {
    const r = decodeProfileRecord(text);
    if (!r.ok) throw r.error;
    return r.value.avatar;
}

function reason(text: string) {
    const r = decodeProfileRecord(text);
    return r.ok ? "ok" : r.error.reason;
}

describe("decodeBase64Strict", () => {
    test("decodes standard base64 with padding", () => {
        expect(decodeBase64Strict(base64(hex(WIRE_HEX)))).toEqual(hex(WIRE_HEX));
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
    test("decodes the core's vectors: the digest in each format, byte for byte", () => {
        // `avatar_records_encode_the_digest_and_format` and
        // `a_gif_avatar_uses_the_shared_image_format`.
        const formats = ["png", "jpeg", "webp", "gif"] as const;
        for (const [i, format] of formats.entries()) {
            const text = `BIgAC9G7V+P56oAZVqdw/hBo+VA4NUespF4dPTVNV9AUyww${"ABCD"[i]}`;
            expect(decodeProfileRecord(text)).toEqual({
                ok: true,
                value: { avatar: { cid: CID, format } },
            });
            expect(record([avatar(i)])).toBe(text);
        }
    });

    test("an entry of a kind this reader does not know is skipped, and survives the envelope", () => {
        // The core's `the_wire_record_preserves_length_prefixed_entries`.
        const text = base64(hex(WIRE_HEX));
        expect(avatarOf(text)).toEqual({ cid: CID, format: "png" });
        const entries = decodeRecordEntries(text);
        expect(entries.ok && entries.value).toEqual([new Uint8Array([7, 0xaa]), avatar(0)]);
    });

    test("an avatar entry a newer writer extended is no avatar", () => {
        // The core's `an_extended_avatar_entry_is_preserved_for_newer_readers`.
        const extended =
            "048c000bd1bb57e3f9ea801956a770fe1068f950383547aca45e1d3d354d57d014cb0c00aa";
        expect(avatarOf(base64(hex(extended)))).toBeNull();
    });

    test("an avatar payload that is not one digest and a format is no avatar", () => {
        // The core's `an_incomplete_avatar_is_preserved_and_skipped`: no bytes,
        // a short digest, a digest with no format.
        const incomplete = [0, 31, 32].map((length) =>
            entry(PROFILE_AVATAR_ENTRY_INDEX, new Uint8Array(length)),
        );
        expect(avatarOf(record(incomplete))).toBeNull();
    });

    test("an avatar in an unknown format is no avatar, and the next avatar wins", () => {
        // The core's `an_avatar_in_an_unknown_format_is_no_avatar`.
        expect(avatarOf(record([avatar(9)]))).toBeNull();
        expect(avatarOf(record([avatar(9), avatar(1)]))).toEqual({ cid: CID, format: "jpeg" });
    });

    test("the first avatar wins", () => {
        // The core's `the_first_avatar_wins`.
        expect(avatarOf(record([avatar(2), avatar(0)]))).toEqual({ cid: CID, format: "webp" });
    });

    test("an empty entry, or none at all, is no avatar", () => {
        expect(avatarOf(record([new Uint8Array(0)]))).toBeNull();
        expect(avatarOf("AA==")).toBeNull();
    });

    test("refuses what is not a record", () => {
        // The core's `a_malformed_record_is_refused`.
        const wire = hex(WIRE_HEX);
        expect(reason(base64(new Uint8Array([...wire, 0])))).toBe("Malformed"); // trailing byte
        expect(reason(base64(wire.subarray(0, wire.length - 1)))).toBe("Malformed"); // truncated
        expect(reason(base64(new Uint8Array()))).toBe("Malformed"); // empty
        expect(reason("not base64!")).toBe("NotBase64");
        expect(reason("QQ=")).toBe("NotBase64");
        const big = profileRecordCodec.enc([entry(9, new Uint8Array(PROFILE_RECORD_MAX_BYTES))]);
        expect(big.length).toBeGreaterThan(PROFILE_RECORD_MAX_BYTES);
        expect(reason(base64(big))).toBe("TooLarge");
    });

    test("refuses a non-minimal compact length in the envelope, as parity-scale-codec does", () => {
        const one = avatar(0);
        // The entry count 1 in the two-byte form, 0x05 0x00, instead of 0x04.
        expect(reason(base64(new Uint8Array([0x05, 0x00, one.length << 2, ...one])))).toBe(
            "Malformed",
        );
        // The entry's own length prefix in the two-byte form.
        const length = new Uint8Array([0x04, ((one.length << 2) | 1) & 0xff, 0x00, ...one]);
        expect(reason(base64(length))).toBe("Malformed");
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
