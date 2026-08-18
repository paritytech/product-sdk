// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS namehash.
 *
 * ENS-style recursive hashing, but rooted at the `.dot` TLD node rather than
 * the empty root — matching `DotnsRegistry` (`contracts/registry/DotnsRegistry.sol`
 * `_namehash`, and `DotnsConstants.sol` `DOT_NODE`).
 *
 *   labelhash(l) = keccak256(utf8(l))
 *   node(parent, l) = keccak256(parent ‖ labelhash(l))
 *   node("alice.dot") = node(DOT_NODE, "alice")
 *   node("bob.alice.dot") = node(node(DOT_NODE, "alice"), "bob")
 *
 * DOT_NODE itself = keccak256(0x00…(32) ‖ keccak256("dot")).
 */
import { bytesToHex, hexToBytes, keccak256 } from "@parity/product-sdk-crypto";

/** The `.dot` TLD node. Mirrors `DotnsConstants.DOT_NODE`. */
export const DOT_NODE = "0x3fce7d1364a893e213bc4212792b517ffc88f5b13b86c8ef9c8d390c3a1370ce";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Compute the DotNS node hash for a name like `"alice.dot"` or
 * `"bob.alice.dot"`.
 *
 * The trailing `.dot` is the TLD (folded into `DOT_NODE`); remaining labels are
 * hashed most-significant-last, so `bob.alice.dot` layers `bob` on top of
 * `alice` on top of the TLD. Input is used as-is — normalize with
 * `normalizeDotNsName` first if needed.
 *
 * @returns the 32-byte node as a `0x`-prefixed hex string.
 */
export function namehash(name: string): `0x${string}` {
    const trimmed = name.endsWith(".dot") ? name.slice(0, -4) : name;
    // "" → the bare TLD node; otherwise split into labels.
    const labels = trimmed === "" ? [] : trimmed.split(".");
    // Layer from the TLD outward: labels are given left-most-first
    // (bob.alice), but must be applied right-to-left onto the parent.
    // Annotated: hexToBytes yields ArrayBufferLike, keccak256 yields ArrayBuffer.
    let node: Uint8Array = hexToBytes(DOT_NODE.slice(2));
    for (let i = labels.length - 1; i >= 0; i--) {
        const labelhash = keccak256(utf8(labels[i]));
        const combined = new Uint8Array(64);
        combined.set(node, 0);
        combined.set(labelhash, 32);
        node = keccak256(combined);
    }
    return `0x${bytesToHex(node)}`;
}
