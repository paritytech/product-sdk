// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { blake2b256, entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { describe, expect, it } from "vitest";
import { deriveProductAccountPublicKey } from "./product-account.js";

function toHex(bytes: Uint8Array): string {
    return `0x${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
}

// Hand-written, not imported, so the test states the layout independently.
function indexBytes(index: number): Uint8Array {
    const magic = blake2b256(new TextEncoder().encode("product-account-index")).subarray(0, 28);
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setUint32(0, index, true);
    bytes.set(magic, 4);
    return bytes;
}

// Derived, not pasted, so the vector pins the hard path and the soft step together.
function productSubtreePublicKey(entropy: Uint8Array, productId: string): Uint8Array {
    return sr25519CreateDerive(entropyToMiniSecret(entropy))(`//product//${productId}`).publicKey;
}

const HOST_VECTOR_ENTROPY = new Uint8Array(16).fill(0xab);

describe("deriveProductAccountPublicKey", () => {
    it("matches the host's own cross-host vector", () => {
        // Vector from host-rust-core tests/wasm_crypto_vectors.rs,
        // product_account_and_entropy_vectors_match_mobile.
        const subtree = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "myapp.dot");
        expect(toHex(subtree)).toBe(
            "0x4a4c063de30994d4341f1effa157ded4e0b340b2e657f238bef3f930faba192b",
        );

        const account = deriveProductAccountPublicKey(subtree, { tag: "Index", value: 0 });
        expect(toHex(account)).toBe(
            "0x1c1ae478b564572f806ffa6352b4273d612beb01610b19f4e5bf444521cd5b5c",
        );
    });

    it("gives each index its own account", () => {
        const subtree = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "myapp.dot");
        const first = deriveProductAccountPublicKey(subtree, { tag: "Index", value: 0 });
        const second = deriveProductAccountPublicKey(subtree, { tag: "Index", value: 1 });
        expect(toHex(first)).not.toBe(toHex(second));
    });

    it("gives each product its own account, because the subtree differs", () => {
        const mine = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "myapp.dot");
        const theirs = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "other.dot");
        expect(toHex(mine)).not.toBe(toHex(theirs));

        const index = { tag: "Index", value: 0 } as const;
        expect(toHex(deriveProductAccountPublicKey(mine, index))).not.toBe(
            toHex(deriveProductAccountPublicKey(theirs, index)),
        );
    });

    it("uses a Raw selector verbatim, so it can reproduce a plain index", () => {
        const subtree = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "myapp.dot");
        const viaIndex = deriveProductAccountPublicKey(subtree, { tag: "Index", value: 3 });
        const viaRaw = deriveProductAccountPublicKey(subtree, {
            tag: "Raw",
            value: indexBytes(3),
        });
        expect(toHex(viaRaw)).toBe(toHex(viaIndex));
    });

    it("keeps Raw and Index in separate spaces", () => {
        const subtree = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "myapp.dot");
        const viaIndex = deriveProductAccountPublicKey(subtree, { tag: "Index", value: 0 });
        const viaRaw = deriveProductAccountPublicKey(subtree, {
            tag: "Raw",
            value: new Uint8Array(32),
        });
        expect(toHex(viaRaw)).not.toBe(toHex(viaIndex));
    });

    it("rejects a subtree key that is not a curve point", () => {
        expect(() =>
            deriveProductAccountPublicKey(new Uint8Array(32).fill(0xff), {
                tag: "Index",
                value: 0,
            }),
        ).toThrow(/ristretto/i);
    });

    it("rejects a Raw selector that is not 32 bytes", () => {
        const subtree = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "myapp.dot");
        expect(() =>
            deriveProductAccountPublicKey(subtree, { tag: "Raw", value: new Uint8Array(31) }),
        ).toThrow(/32 bytes/);
    });

    it("rejects an index outside u32", () => {
        const subtree = productSubtreePublicKey(HOST_VECTOR_ENTROPY, "myapp.dot");
        for (const value of [-1, 1.5, 0x1_00_00_00_00]) {
            expect(() => deriveProductAccountPublicKey(subtree, { tag: "Index", value })).toThrow(
                /range/i,
            );
        }
    });
});
