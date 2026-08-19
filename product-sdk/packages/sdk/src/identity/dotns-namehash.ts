// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS namehash.
 *
 * ENS-style recursive hashing, but rooted at the network's TLD node rather than
 * the empty root — matching `DotnsRegistry` (`contracts/registry/DotnsRegistry.sol`
 * `_namehash`) and `LabelUtils.namehashUnder`.
 *
 *   labelhash(l) = keccak256(utf8(l))
 *   node(parent, l) = keccak256(parent ‖ labelhash(l))
 *   node("alice.paseo") = node(tldNode, "alice")
 *   node("bob.alice.paseo") = node(node(tldNode, "alice"), "bob")
 *
 * The root is **per network**, not a constant. `DotnsProtocolRegistry.initialize`
 * fixes it once from a deploy-time label — `.dot` on Paseo Asset Hub Previewnet,
 * `.paseo` on Next V2 — and publishes it as `tld()` / `tldNode()`. Hashing under
 * the wrong root yields a node the chain has never written to, so every lookup
 * reports "unregistered" with no error anywhere. That is why {@link namehash}
 * takes the root rather than assuming one; `resolveTld` in `./dotns-registry.js`
 * is what asks the chain for it.
 */
import { bytesToHex, hexToBytes, keccak256 } from "@parity/product-sdk-crypto";

/**
 * A network's DotNS top-level domain: the suffix names are spelled with, and
 * the node every one of its names hashes onto.
 *
 * The two must agree — `node` is `namehash(0, labelhash(label))` of `suffix`'s
 * label — so build one with {@link dotNsTld} rather than by hand, and check an
 * externally supplied pair with {@link isConsistentDotNsTld}. A `.paseo` suffix
 * carrying the `.dot` node is exactly the defect this type exists to prevent.
 */
export interface DotNsTld {
    /** Suffix including the leading dot, as `protocolRegistry.tld()` returns it. */
    suffix: string;
    /** Namehash of the TLD label, as `protocolRegistry.tldNode()` returns it. */
    node: `0x${string}`;
}

/** The `.dot` TLD node. Mirrors the `DotnsConstants.DOT_NODE` the contracts removed in `b4096968`. */
export const DOT_NODE = "0x3fce7d1364a893e213bc4212792b517ffc88f5b13b86c8ef9c8d390c3a1370ce";

const ZERO_NODE = `0x${"00".repeat(32)}`;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** `keccak256(parent ‖ labelhash(label))`, the one hash step every node is built from. */
function nodeUnder(parent: Uint8Array, label: string): Uint8Array {
    const combined = new Uint8Array(64);
    combined.set(parent, 0);
    combined.set(keccak256(utf8(label)), 32);
    return keccak256(combined);
}

/**
 * Build a {@link DotNsTld} from a TLD suffix, deriving the node the same way the
 * contract does.
 *
 * Mirrors `DotnsProtocolRegistry.initialize`, which sets
 * `_tldNode = namehashUnder(bytes32(0), labelhash(tldLabel))`. Because the node
 * is a pure function of the label, a client only ever needs the suffix — reading
 * `tldNode()` is a cross-check, never the source.
 *
 * Accepts `".paseo"` or `"paseo"`: `tld()` returns the dotted form while
 * `initialize` and the deploy pipeline speak the bare label.
 */
export function dotNsTld(suffix: string): DotNsTld {
    const label = suffix.startsWith(".") ? suffix.slice(1) : suffix;
    return {
        suffix: `.${label}`,
        node: `0x${bytesToHex(nodeUnder(hexToBytes(ZERO_NODE.slice(2)), label))}`,
    };
}

/**
 * Whether a {@link DotNsTld} could have come from a real deployment.
 *
 * Three ways a pair fails, all of which produce silently wrong nodes rather
 * than errors if they reach {@link namehash}:
 *
 *   - the node is not the derivation of the suffix (a caller mixing `.paseo`
 *     with `DOT_NODE`);
 *   - the suffix is empty, or the node is zero — what a pre-`b4096968` registry
 *     proxy reports after an upgrade with no reinitializer, since `_tld` and
 *     `_tldNode` are then still at their defaults and *both getters succeed*;
 *   - the suffix is not a single label, which `initialize` rejects outright.
 *
 * Returns a boolean rather than a `Result` to keep this module free of the
 * error type; callers with an error channel (`resolveTld`) map `false` to an
 * `err` carrying the offending value.
 */
export function isConsistentDotNsTld(tld: DotNsTld): boolean {
    const label = tld.suffix.startsWith(".") ? tld.suffix.slice(1) : tld.suffix;
    if (label.length === 0 || label.includes(".")) return false;
    if (tld.node.toLowerCase() === ZERO_NODE) return false;
    return dotNsTld(label).node.toLowerCase() === tld.node.toLowerCase();
}

/** The `.dot` TLD, for a deployment that uses it. Not a default: pass it explicitly. */
export const DOT_TLD: DotNsTld = { suffix: ".dot", node: DOT_NODE };

/**
 * Compute the DotNS node hash for a name like `"alice.paseo"` or
 * `"bob.alice.paseo"`, rooted at `tld`.
 *
 * The trailing suffix is the TLD (folded into `tld.node`); remaining labels are
 * hashed most-significant-last, so `bob.alice.paseo` layers `bob` on top of
 * `alice` on top of the TLD. Input is used as-is — normalize with
 * `normalizeDotNsName` first if needed.
 *
 * `tld` is required rather than defaulted, because a default that is correct on
 * one deployment is the defect this module was fixed for. It is also not
 * validated here: a name whose suffix belongs to another deployment hashes to a
 * node under `tld` instead of being refused, since this function returns a hash
 * and has nowhere to report a complaint. The entry points in
 * `./dotns-registry.js` do that check, where there is an error channel.
 *
 * @returns the 32-byte node as a `0x`-prefixed hex string.
 */
export function namehash(name: string, tld: DotNsTld): `0x${string}` {
    const trimmed = name.endsWith(tld.suffix) ? name.slice(0, -tld.suffix.length) : name;
    // "" → the bare TLD node; otherwise split into labels.
    const labels = trimmed === "" ? [] : trimmed.split(".");
    // Layer from the TLD outward: labels are given left-most-first
    // (bob.alice), but must be applied right-to-left onto the parent.
    // Annotated: hexToBytes yields ArrayBufferLike, keccak256 yields ArrayBuffer.
    let node: Uint8Array = hexToBytes(tld.node.slice(2));
    for (let i = labels.length - 1; i >= 0; i--) {
        node = nodeUnder(node, labels[i]);
    }
    return `0x${bytesToHex(node)}`;
}
