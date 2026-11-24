// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The writer against the bytes the reader pins, and against the host
// publisher's rules (`ProfileRecord::set_avatar` and its tests in the core).
// Expected records are built from the codecs directly, as `record.test.ts`
// builds its vectors, so a test asserts the layout and not only a round trip.
import { blake2b256, bytesToHex } from "@parity/product-sdk-crypto";
import { artworkAddress } from "@parity/product-sdk-nfts";
import { describe, expect, test } from "vitest";
import { profileAvatarCodec, profileRecordCodec } from "./codec.js";
import { encodeProfileRecord, rewriteProfileRecord } from "./encode.js";
import { decodeProfileRecord } from "./record.js";
import { PROFILE_RECORD_MAX_BYTES, type ProfilePatch } from "./types.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** One entry as the wrapper carries it: the variant index, then the payload. */
const entry = (index: number, payload: Uint8Array) => new Uint8Array([index, ...payload]);
/** A record from its entries, base64, as the text record carries it. */
const record = (entries: Uint8Array[]) => base64(profileRecordCodec.enc(entries));

const digestOf = (seed: string) => `0x${bytesToHex(blake2b256(utf8(seed)))}` as const;
const cidOf = (seed: string) => artworkAddress({ hex: digestOf(seed), text: null })?.cid as string;
const CID = cidOf("avatar");

/** The avatar entry for the bytes `seed` stands for: its digest, then the format. */
const avatar = (seed: string, format: number) =>
    entry(0, profileAvatarCodec.enc({ cid: digestOf(seed), format }));
/** Entries of kinds this writer does not read, which another writer may have added. */
const OTHER = new Uint8Array([1, 4, 0x41]);
const OPAQUE = new Uint8Array([9, 1, 2, 3]);
/** An avatar in a format this writer does not know: index 0, but no avatar for this reader. */
const FUTURE_AVATAR = avatar("avatar", 9);

function rewrite(live: string | null, patch: ProfilePatch): string {
    const r = rewriteProfileRecord(live, patch);
    if (!r.ok) throw r.error;
    return r.value;
}
function refused(live: string | null, patch: ProfilePatch): string {
    const r = rewriteProfileRecord(live, patch);
    if (r.ok) throw new Error(`expected a refusal, got ${r.value}`);
    return r.error.reason;
}

describe("encodeProfileRecord", () => {
    test("an empty record is AA==, the core's calldata vector", () => {
        expect(encodeProfileRecord([])).toEqual({ ok: true, value: "AA==" });
    });

    test("refuses a record over the bound", () => {
        const r = encodeProfileRecord([new Uint8Array(PROFILE_RECORD_MAX_BYTES)]);
        expect(r.ok ? null : r.error.reason).toBe("TooLarge");
    });
});

describe("rewriteProfileRecord", () => {
    test("no live record, an empty one and a blank one are the same start", () => {
        const expected = record([avatar("avatar", 2)]);
        const patch = { avatar: { cid: CID, format: "webp" } } as const;
        expect(rewrite(null, patch)).toBe(expected);
        expect(rewrite("", patch)).toBe(expected);
        expect(rewrite("  AA==\n", patch)).toBe(expected);
    });

    test("a patch that names nothing carries the record unchanged", () => {
        const live = record([avatar("avatar", 0), OTHER, OPAQUE]);
        expect(rewrite(live, {})).toBe(live);
    });

    test("a new avatar replaces the avatar readers show and goes first, the rest in order", () => {
        // The core's `a_new_avatar_replaces_the_one_readers_show_and_keeps_other_entries`.
        const live = record([OTHER, avatar("other", 0), OPAQUE]);
        expect(rewrite(live, { avatar: { cid: CID, format: "png" } })).toBe(
            record([avatar("avatar", 0), OTHER, OPAQUE]),
        );
    });

    test("only the shown avatar is replaced; a second decodable one is carried", () => {
        const live = record([avatar("first", 0), avatar("second", 1)]);
        expect(rewrite(live, { avatar: { cid: CID, format: "png" } })).toBe(
            record([avatar("avatar", 0), avatar("second", 1)]),
        );
    });

    test("a new avatar precedes an avatar in a format this writer does not know, which is kept", () => {
        const live = record([FUTURE_AVATAR, avatar("other", 0)]);
        expect(rewrite(live, { avatar: { cid: CID, format: "png" } })).toBe(
            record([avatar("avatar", 0), FUTURE_AVATAR]),
        );
    });

    test("clearing the avatar drops every avatar entry, the unknown-format one included", () => {
        const live = record([FUTURE_AVATAR, avatar("other", 0), OTHER]);
        expect(rewrite(live, { avatar: null })).toBe(record([OTHER]));
        expect(rewrite(record([avatar("other", 0)]), { avatar: null })).toBe("AA==");
    });

    test("a live record that is not a profile is refused, not replaced", () => {
        const patch = { avatar: { cid: CID, format: "png" } } as const;
        expect(refused("not base64!", patch)).toBe("NotBase64");
        // The layout that preceded the RFC, as `record.test.ts` pins it.
        expect(
            refused(
                "CBhhdmF0YXIBAfhiYWZrMmJ6YWNlYnRtdW41Znk2NjNkdmZ3eWMzMzZjeHdkbGhtc2VraTNtanNlazZ3bXN5Z3R2ZjJuYjRlZwIQbmFtZRhkZXZkZXY=",
                patch,
            ),
        ).toBe("Malformed");
        expect(
            refused(base64(profileRecordCodec.enc([new Uint8Array(PROFILE_RECORD_MAX_BYTES)])), {
                avatar: null,
            }),
        ).toBe("TooLarge");
    });

    test("an avatar no entry can carry is refused", () => {
        expect(refused(null, { avatar: { cid: "not-a-cid", format: "png" } })).toBe("InvalidEntry");
    });

    test("a record that would exceed the bound is refused before it is written", () => {
        // A live record just within the bound, the carried entry counting toward it.
        const live = record([entry(9, new Uint8Array(PROFILE_RECORD_MAX_BYTES - 20))]);
        expect(decodeProfileRecord(live).ok).toBe(true);
        expect(refused(live, { avatar: { cid: CID, format: "png" } })).toBe("TooLarge");
    });

    test("every rewrite reads back through the reader", () => {
        const text = rewrite(record([OPAQUE, FUTURE_AVATAR, OTHER]), {
            avatar: { cid: CID, format: "jpeg" },
        });
        expect(decodeProfileRecord(text)).toEqual({
            ok: true,
            value: { avatar: { cid: CID, format: "jpeg" } },
        });
    });
});
