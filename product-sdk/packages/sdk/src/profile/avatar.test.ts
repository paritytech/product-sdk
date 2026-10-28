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

import { loadAvatar } from "./avatar.js";

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
