// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The writer against the bytes the reader pins, and against the core's own
// publisher rules (`ProfileRecord::set_avatar` and its tests in host-rust-core).
// Expected records are built from the codecs directly, as `record.test.ts`
// builds its vectors, so a test asserts the layout and not only a round trip.
import { blake2b256, bytesToHex } from "@parity/product-sdk-crypto";
import { artworkAddress } from "@parity/product-sdk-nfts";
import { describe, expect, test } from "vitest";

import {
    profileAvatarCodec,
    profileFeedCodec,
    profileNameCodec,
    profileNftCodec,
    profileRecordCodec,
} from "./codec.js";
import { decodeProfileRecord, encodeBase64 } from "./record.js";
import { encodeProfileRecord, rewriteProfileRecord } from "./encode.js";
import { PROFILE_RECORD_MAX_BYTES, type ProfilePatch } from "./types.js";

const utf8 = (s: string) => new TextEncoder().encode(s);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** One entry as the wrapper carries it: the variant index, then the payload. */
const entry = (index: number, payload: Uint8Array) => new Uint8Array([index, ...payload]);
/** A record from its entries, base64, as the text record carries it. */
const record = (entries: Uint8Array[]) => base64(profileRecordCodec.enc(entries));

const cidOf = (seed: string) =>
    artworkAddress({ hex: `0x${bytesToHex(blake2b256(utf8(seed)))}`, text: null })?.cid as string;
const CID = cidOf("avatar");
const OTHER_CID = cidOf("other");
const PURSE = `0x${"ab".repeat(32)}` as const;
const TOPIC = `0x${"11".repeat(32)}` as const;
const SIGNER = `0x${"22".repeat(32)}` as const;

const avatar = (cid: string, format: number) =>
    entry(0, profileAvatarCodec.enc({ cid: utf8(cid), format }));
const name = (text: string) => entry(1, profileNameCodec.enc(utf8(text)));
const nft = (instance: bigint) =>
    entry(2, profileNftCodec.enc({ instance, collection: 7, item: 3, purse: PURSE }));
const feed = (kind: string) =>
    entry(3, profileFeedCodec.enc({ kind: utf8(kind), topic: TOPIC, signer: SIGNER }));
/** An entry of a kind this writer does not know. */
const OPAQUE = new Uint8Array([9, 1, 2, 3]);
/** An avatar in a format this writer does not know: index 0, but no avatar for this reader. */
const FUTURE_AVATAR = avatar(CID, 9);

const pin = (instance: bigint) => ({ instance, collection: 7, item: 3, purse: PURSE });
const MOOD = { kind: "mood", topic: TOPIC, signer: SIGNER };

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

describe("encodeBase64", () => {
    test("is standard base64 with padding at every length mod 3", () => {
        for (let length = 0; length < 8; length++) {
            const bytes = Uint8Array.from({ length }, (_, i) => 250 + i);
            expect(encodeBase64(bytes)).toBe(base64(bytes));
        }
    });
});

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
    test("a fresh record: the avatar first, then the name, the pins and the feeds", () => {
        const text = rewrite(null, {
            avatar: { cid: CID, format: "webp" },
            name: "Alice",
            nfts: [pin(1n)],
            feeds: [MOOD],
        });
        expect(text).toBe(record([avatar(CID, 2), name("Alice"), nft(1n), feed("mood")]));
    });

    test("no live record, an empty one and a blank one are the same start", () => {
        const expected = record([name("Alice")]);
        expect(rewrite(null, { name: "Alice" })).toBe(expected);
        expect(rewrite("", { name: "Alice" })).toBe(expected);
        expect(rewrite("  AA==\n", { name: "Alice" })).toBe(expected);
    });

    test("a patch that names nothing carries the record unchanged", () => {
        const live = record([avatar(CID, 0), name("Alice"), OPAQUE]);
        expect(rewrite(live, {})).toBe(live);
    });

    test("a new avatar replaces the first avatar this writer can decode and goes first", () => {
        const live = record([name("Alice"), avatar(OTHER_CID, 0)]);
        expect(rewrite(live, { avatar: { cid: CID, format: "png" } })).toBe(
            record([avatar(CID, 0), name("Alice")]),
        );
    });

    test("a new avatar precedes an avatar in a format this writer does not know, which is kept", () => {
        // The core's `a_new_avatar_precedes_opaque_avatars_from_newer_writers`.
        const live = record([FUTURE_AVATAR, avatar(OTHER_CID, 0)]);
        expect(rewrite(live, { avatar: { cid: CID, format: "png" } })).toBe(
            record([avatar(CID, 0), FUTURE_AVATAR]),
        );
    });

    test("clearing the avatar drops every avatar entry, the unknown-format one included", () => {
        const live = record([FUTURE_AVATAR, avatar(OTHER_CID, 0), name("Alice")]);
        expect(rewrite(live, { avatar: null })).toBe(record([name("Alice")]));
    });

    test("an entry of an unknown kind is carried as read, in place", () => {
        const live = record([OPAQUE, name("Alice")]);
        expect(rewrite(live, { name: "Bob" })).toBe(record([OPAQUE, name("Bob")]));
    });

    test("a name replaces every name entry, and null drops them", () => {
        const live = record([name("A"), OPAQUE, name("B")]);
        expect(rewrite(live, { name: "C" })).toBe(record([OPAQUE, name("C")]));
        expect(rewrite(live, { name: null })).toBe(record([OPAQUE]));
    });

    test("pins are one list: replaced whole, cleared by null or an empty list", () => {
        const live = record([nft(1n), nft(2n)]);
        expect(rewrite(live, { nfts: [pin(3n)] })).toBe(record([nft(3n)]));
        expect(rewrite(live, { nfts: null })).toBe("AA==");
    });

    test("feeds replace only the kinds they name, and null drops them all", () => {
        const live = record([feed("mood"), feed("status")]);
        expect(rewrite(live, { feeds: [MOOD] })).toBe(record([feed("status"), feed("mood")]));
        expect(rewrite(live, { feeds: null })).toBe("AA==");
    });

    test("a feed entry this writer cannot read is not its to drop", () => {
        const unreadable = entry(3, new Uint8Array([1, 2]));
        const live = record([unreadable]);
        expect(rewrite(live, { feeds: [MOOD] })).toBe(record([unreadable, feed("mood")]));
    });

    test("a live record that is not a profile is refused, not replaced", () => {
        expect(refused("not base64!", { name: "Alice" })).toBe("NotBase64");
        // The layout that preceded the RFC, as `record.test.ts` pins it.
        expect(
            refused(
                "CBhhdmF0YXIBAfhiYWZrMmJ6YWNlYnRtdW41Znk2NjNkdmZ3eWMzMzZjeHdkbGhtc2VraTNtanNlazZ3bXN5Z3R2ZjJuYjRlZwIQbmFtZRhkZXZkZXY=",
                { name: "Alice" },
            ),
        ).toBe("Malformed");
        expect(
            refused(base64(profileRecordCodec.enc([new Uint8Array(PROFILE_RECORD_MAX_BYTES)])), {
                name: "Alice",
            }),
        ).toBe("TooLarge");
    });

    test("a patch value no entry can carry is refused", () => {
        expect(refused(null, { name: "" })).toBe("InvalidEntry");
        expect(refused(null, { name: "x".repeat(65) })).toBe("InvalidEntry");
        expect(refused(null, { avatar: { cid: "not-a-cid", format: "png" } })).toBe("InvalidEntry");
        expect(refused(null, { nfts: [{ ...pin(1n), purse: "0x1234" }] })).toBe("InvalidEntry");
        expect(refused(null, { nfts: [pin(2n ** 64n)] })).toBe("InvalidEntry");
        expect(refused(null, { nfts: [{ ...pin(1n), item: -1 }] })).toBe("InvalidEntry");
        expect(refused(null, { feeds: [{ ...MOOD, kind: "" }] })).toBe("InvalidEntry");
        expect(refused(null, { feeds: [{ ...MOOD, topic: "0x12" }] })).toBe("InvalidEntry");
    });

    test("a 64-byte name is the longest accepted, measured in UTF-8", () => {
        expect(rewrite(null, { name: "é".repeat(32) })).toBe(record([name("é".repeat(32))]));
        expect(refused(null, { name: "é".repeat(33) })).toBe("InvalidEntry");
    });

    test("a record that would exceed the bound is refused before it is written", () => {
        const pins = Array.from({ length: 400 }, (_, i) => pin(BigInt(i)));
        expect(refused(null, { nfts: pins })).toBe("TooLarge");
    });

    test("every rewrite reads back through the reader", () => {
        const live = record([OPAQUE, FUTURE_AVATAR, feed("status")]);
        const text = rewrite(live, {
            avatar: { cid: CID, format: "jpeg" },
            name: "Alice",
            nfts: [pin(5n)],
            feeds: [MOOD],
        });
        expect(decodeProfileRecord(text)).toEqual({
            ok: true,
            value: {
                avatar: { cid: CID, format: "jpeg" },
                name: "Alice",
                nfts: [pin(5n)],
                feeds: [{ kind: "status", topic: TOPIC, signer: SIGNER }, MOOD],
                unknown: [{ bytes: OPAQUE }, { bytes: FUTURE_AVATAR }],
            },
        });
    });
});

describe("an entry this writer cannot read is carried, whatever its index", () => {
    /** Index 1, but not valid UTF-8: the reader keeps it as unknown, so the writer does too. */
    const BAD_NAME = entry(1, profileNameCodec.enc(new Uint8Array([0xff, 0xfe])));
    /** Index 2, but not one ProfileNft. */
    const BAD_NFT = entry(2, new Uint8Array([1, 2, 3]));
    /** Index 3, but not one ProfileFeed. */
    const BAD_FEED = entry(3, new Uint8Array([1]));

    test("a name that does not decode survives a name replace and a clear", () => {
        const live = record([BAD_NAME, name("A")]);
        expect(rewrite(live, { name: "B" })).toBe(record([BAD_NAME, name("B")]));
        expect(rewrite(live, { name: null })).toBe(record([BAD_NAME]));
    });

    test("a pin that does not decode survives a pin replace", () => {
        const live = record([BAD_NFT, nft(1n)]);
        expect(rewrite(live, { nfts: [pin(2n)] })).toBe(record([BAD_NFT, nft(2n)]));
    });

    test("a feed that does not decode survives feeds: null", () => {
        const live = record([BAD_FEED, feed("mood")]);
        expect(rewrite(live, { feeds: null })).toBe(record([BAD_FEED]));
    });

    test("what the writer carries is what the reader reports as unknown", () => {
        const text = rewrite(record([BAD_NAME, BAD_NFT, BAD_FEED]), {
            name: "A",
            nfts: [],
            feeds: null,
        });
        const read = decodeProfileRecord(text);
        expect(read.ok && read.value.unknown.map((u) => u.bytes)).toEqual([
            BAD_NAME,
            BAD_NFT,
            BAD_FEED,
        ]);
    });
});

describe("a pin that is not a ProfileNft is refused, not thrown", () => {
    test("an instance that is not a bigint, as JSON gives back", () => {
        const fromJson = { ...pin(9n), instance: "9" as unknown as bigint };
        expect(refused(null, { nfts: [fromJson] })).toBe("InvalidEntry");
        expect(refused(null, { nfts: [{ ...pin(9n), instance: 9 as unknown as bigint }] })).toBe(
            "InvalidEntry",
        );
    });
});
