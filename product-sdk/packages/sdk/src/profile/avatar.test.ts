// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The avatar fetch through the fake host's preimage domain, keyed by the
// blake2b-256 digest the CID carries.
import { blake2b256, bytesToHex } from "@parity/product-sdk-crypto";
import { getPreimageManager, type PreimageManager } from "@parity/product-sdk-host";
import { createFakeHost } from "@parity/product-sdk-host/testing";
import { artworkAddress } from "@parity/product-sdk-nfts";
import { afterEach, describe, expect, test } from "vitest";

import { loadAvatar, submitAvatar } from "./avatar.js";
import { PROFILE_AVATAR_MAX_BYTES } from "./types.js";

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const DIGEST = `0x${bytesToHex(blake2b256(BYTES))}` as const;
/** The raw/blake2b-256 CID for `DIGEST`, built the way the catalogue builds one from a digest. */
const CID = artworkAddress({ hex: DIGEST, text: null })?.cid as string;

let dispose: (() => void) | null = null;

async function managerWith(preimages: Record<string, Uint8Array>): Promise<PreimageManager> {
    const host = createFakeHost({ preimages });
    dispose = () => host.dispose();
    const manager = await getPreimageManager();
    if (manager === null) throw new Error("the fake host exposes no preimage manager");
    return manager;
}

afterEach(() => {
    dispose?.();
    dispose = null;
});

describe("loadAvatar", () => {
    test("returns bytes that hash to the CID, with the declared MIME type", async () => {
        const manager = await managerWith({ [DIGEST]: BYTES });
        const loaded = await loadAvatar({ cid: CID, format: "webp" }, manager);
        expect(loaded).toEqual({ cid: CID, format: "webp", mimeType: "image/webp", bytes: BYTES });
    });

    test("maps each format to its MIME type without looking at the bytes", async () => {
        const manager = await managerWith({ [DIGEST]: BYTES });
        expect((await loadAvatar({ cid: CID, format: "png" }, manager))?.mimeType).toBe(
            "image/png",
        );
        expect((await loadAvatar({ cid: CID, format: "jpeg" }, manager))?.mimeType).toBe(
            "image/jpeg",
        );
    });

    test("bytes the host does not have are no avatar this time", async () => {
        const manager = await managerWith({});
        expect(
            await loadAvatar({ cid: CID, format: "webp" }, manager, { timeoutMs: 20 }),
        ).toBeNull();
    });

    test("bytes over the RFC's bound are no avatar, even when they hash to the CID", async () => {
        const big = new Uint8Array(PROFILE_AVATAR_MAX_BYTES + 1).fill(0x42);
        const digest = `0x${bytesToHex(blake2b256(big))}` as const;
        const cid = artworkAddress({ hex: digest, text: null })?.cid as string;
        const manager = await managerWith({ [digest]: big });
        expect(await loadAvatar({ cid, format: "png" }, manager)).toBeNull();
        // One byte fewer is within the bound and comes back.
        const fits = big.subarray(0, PROFILE_AVATAR_MAX_BYTES);
        const fitsDigest = `0x${bytesToHex(blake2b256(fits))}` as const;
        const fitsCid = artworkAddress({ hex: fitsDigest, text: null })?.cid as string;
        dispose?.();
        const manager2 = await managerWith({ [fitsDigest]: fits });
        expect((await loadAvatar({ cid: fitsCid, format: "png" }, manager2))?.bytes).toHaveLength(
            PROFILE_AVATAR_MAX_BYTES,
        );
    });

    test("bytes that do not hash to the CID are no avatar", async () => {
        const manager = await managerWith({ [DIGEST]: new Uint8Array([9, 9, 9]) });
        expect(await loadAvatar({ cid: CID, format: "webp" }, manager)).toBeNull();
    });

    test("a CID that is not a Bulletin preimage CID is no avatar, and the host is not asked", async () => {
        let asked = 0;
        const manager: PreimageManager = {
            lookup: () => {
                asked++;
                return { unsubscribe: () => {}, onInterrupt: () => () => {} };
            },
            submit: async () => "0x00",
        };
        // dag-pb, sha2-256: a CID of a UnixFS node, not of the bytes themselves.
        const dagPb = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
        expect(await loadAvatar({ cid: dagPb, format: "png" }, manager)).toBeNull();
        expect(
            await loadAvatar(
                { cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", format: "png" },
                manager,
            ),
        ).toBeNull();
        expect(await loadAvatar({ cid: "", format: "png" }, manager)).toBeNull();
        expect(asked).toBe(0);
    });
});

/**
 * A hand-rolled manager rather than the fake host's: that one keys preimages
 * by a cheap hash, and `submitAvatar` holds the host to the real digest.
 */
function managerThatAnswers(answer: (bytes: Uint8Array) => Promise<`0x${string}`>) {
    const submitted: Uint8Array[] = [];
    const manager: PreimageManager = {
        lookup: () => ({ unsubscribe() {}, onInterrupt: () => () => {} }),
        submit: async (bytes) => {
            submitted.push(bytes);
            return answer(bytes);
        },
    };
    return { manager, submitted };
}
const digestOf = (bytes: Uint8Array) => `0x${bytesToHex(blake2b256(bytes))}` as const;

describe("submitAvatar", () => {
    test("stores the bytes and answers the CID the reader fetches by", async () => {
        const { manager, submitted } = managerThatAnswers(async (bytes) => digestOf(bytes));
        expect(await submitAvatar(BYTES, "webp", manager)).toEqual({
            ok: true,
            value: { cid: CID, format: "webp" },
        });
        expect(submitted).toEqual([BYTES]);
    });

    test("refuses bytes over the bound before asking the host", async () => {
        const { manager, submitted } = managerThatAnswers(async (bytes) => digestOf(bytes));
        const big = new Uint8Array(PROFILE_AVATAR_MAX_BYTES + 1);
        big.set(BYTES);
        const r = await submitAvatar(big, "webp", manager);
        expect(r.ok ? null : r.error.reason).toBe("TooLarge");
        expect(submitted).toHaveLength(0);
    });

    test("a host that does not store the bytes is a Storage error with the cause", async () => {
        const { manager } = managerThatAnswers(async () => {
            throw new Error("allowance refused");
        });
        const r = await submitAvatar(BYTES, "webp", manager);
        expect(r.ok ? null : r.error.reason).toBe("Storage");
        expect(r.ok ? null : (r.error.cause as Error).message).toBe("allowance refused");
    });

    test("a key that is not the digest of the bytes is a Storage error, never a CID", async () => {
        const { manager } = managerThatAnswers(async () => `0x${"00".repeat(32)}`);
        const r = await submitAvatar(BYTES, "webp", manager);
        expect(r.ok ? null : r.error.reason).toBe("Storage");
    });

    test("the key comparison ignores hex casing", async () => {
        const { manager } = managerThatAnswers(
            async (bytes) => digestOf(bytes).toUpperCase().replace("0X", "0x") as `0x${string}`,
        );
        expect((await submitAvatar(BYTES, "webp", manager)).ok).toBe(true);
    });
});
