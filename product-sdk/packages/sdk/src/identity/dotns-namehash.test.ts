// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { bytesToHex, keccak256 } from "@parity/product-sdk-crypto";
import { describe, expect, test } from "vitest";
import { DOT_NODE, DOT_TLD, dotNsTld, isConsistentDotNsTld, namehash } from "./dotns-namehash.js";

// Independent reference implementation of the same algorithm, so the test
// pins behaviour rather than restating the code.
function hexBytes(hex: string): Uint8Array {
    const pairs = hex.slice(2).match(/.{2}/g) ?? [];
    return Uint8Array.from(pairs.map((b) => Number.parseInt(b, 16)));
}

function refNamehash(name: string, suffix: string, root: string): string {
    const trimmed = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    const labels = trimmed === "" ? [] : trimmed.split(".");
    let node = hexBytes(root);
    for (let i = labels.length - 1; i >= 0; i--) {
        const lh = keccak256(new TextEncoder().encode(labels[i]));
        const combined = new Uint8Array(64);
        combined.set(node, 0);
        combined.set(lh, 32);
        node = keccak256(combined);
    }
    return `0x${bytesToHex(node)}`;
}

/**
 * The `.paseo` TLD node, as `DotnsProtocolRegistry.tldNode()` reports it on
 * Paseo Asset Hub Next V2.
 *
 * Pinned as an observed literal on purpose: it is the one value that proves our
 * derivation matches what the contract computed at initialisation. Deriving it
 * here instead would make the test agree with the code by construction.
 *
 * Needs no re-verification — it is `keccak256(0x00…00 ‖ keccak256("paseo"))`,
 * so it is fixed by the label alone, not by any deployment's current state.
 */
const PASEO_NODE_FROM_CHAIN = "0x096b436ee9a398429fe33ad4b359bad4398dd74b412ec1dd043c93dfbf581874";

const PASEO_TLD = dotNsTld(".paseo");

describe("dotns namehash", () => {
    test("DOT_NODE is keccak256(zeros32 || keccak256('dot'))", () => {
        // The only hardcoded value in the module: every node hash derives from
        // it, and namehash(".dot") returning it is a tautology, since an empty
        // label list skips the loop. Derive it instead.
        const labelhash = keccak256(new TextEncoder().encode("dot"));
        const combined = new Uint8Array(64); // leading 32 bytes are the zero root
        combined.set(labelhash, 32);
        expect(`0x${bytesToHex(keccak256(combined))}`).toBe(DOT_NODE);
    });

    test("bare .dot hashes to the DOT_NODE constant", () => {
        expect(namehash(".dot", DOT_TLD)).toBe(DOT_NODE);
        expect(namehash("", DOT_TLD)).toBe(DOT_NODE);
    });

    test("normalizes the same with or without the .dot suffix", () => {
        expect(namehash("alice.dot", DOT_TLD)).toBe(namehash("alice", DOT_TLD));
    });

    test("matches the reference algorithm for single + sub labels", () => {
        expect(namehash("alice.dot", DOT_TLD)).toBe(refNamehash("alice.dot", ".dot", DOT_NODE));
        expect(namehash("bob.alice.dot", DOT_TLD)).toBe(
            refNamehash("bob.alice.dot", ".dot", DOT_NODE),
        );
    });

    test("distinct names produce distinct nodes", () => {
        expect(namehash("alice.dot", DOT_TLD)).not.toBe(namehash("bob.dot", DOT_TLD));
    });

    test("returns a 32-byte 0x-hex string", () => {
        expect(namehash("alice.dot", DOT_TLD)).toMatch(/^0x[0-9a-f]{64}$/);
    });

    test("roots at the TLD it is given, matching the reference algorithm", () => {
        expect(namehash("alice.paseo", PASEO_TLD)).toBe(
            refNamehash("alice.paseo", ".paseo", PASEO_NODE_FROM_CHAIN),
        );
        expect(namehash("bob.alice.paseo", PASEO_TLD)).toBe(
            refNamehash("bob.alice.paseo", ".paseo", PASEO_NODE_FROM_CHAIN),
        );
    });

    test("the same label under two TLDs gives two different nodes", () => {
        // The bug this whole change exists for, in one assertion: `dim2` is
        // owned on paseo-asset-hub-next under `.paseo` and unowned under `.dot`.
        expect(namehash("alice.paseo", PASEO_TLD)).not.toBe(namehash("alice.dot", DOT_TLD));
    });

    test("strips the suffix by length, not by a hardcoded 4", () => {
        // `slice(0, -4)` would leave the label `alice.pa`, which hashes as the
        // subname `pa` under `alice`.
        const wrong = refNamehash("alice.pa", ".paseo", PASEO_NODE_FROM_CHAIN);
        expect(namehash("alice.paseo", PASEO_TLD)).not.toBe(wrong);
        expect(namehash("alice.paseo", PASEO_TLD)).toBe(namehash("alice", PASEO_TLD));
    });
});

describe("dotNsTld", () => {
    test("derives the .paseo node the contract computed at initialisation", () => {
        // `DotnsProtocolRegistry.initialize` sets
        // `_tldNode = namehashUnder(0, labelhash(tldLabel))`, so the node is a
        // pure function of the suffix and we never need to read `tldNode()`.
        expect(dotNsTld(".paseo").node).toBe(PASEO_NODE_FROM_CHAIN);
    });

    test("derives DOT_NODE for .dot, tying the helper to the constant", () => {
        expect(dotNsTld(".dot").node).toBe(DOT_NODE);
        expect(dotNsTld(".dot")).toEqual(DOT_TLD);
    });

    test("keeps the suffix verbatim, including its leading dot", () => {
        expect(dotNsTld(".paseo").suffix).toBe(".paseo");
    });

    test("accepts a bare label as well as a dotted suffix", () => {
        // `tld()` returns ".paseo" but the deploy pipeline and `initialize`
        // both speak the bare label, so accept either spelling.
        expect(dotNsTld("paseo")).toEqual(dotNsTld(".paseo"));
    });
});

describe("isConsistentDotNsTld", () => {
    test("accepts a pair whose node is the derivation of its suffix", () => {
        expect(isConsistentDotNsTld(DOT_TLD)).toBe(true);
        expect(isConsistentDotNsTld(PASEO_TLD)).toBe(true);
    });

    test("rejects a suffix paired with another TLD's node", () => {
        // The override-path form of the original bug: `.paseo` names rooted at
        // the `.dot` node resolve to nodes nobody owns.
        expect(isConsistentDotNsTld({ suffix: ".paseo", node: DOT_NODE })).toBe(false);
    });

    test("rejects an empty suffix and a zero node", () => {
        // What a pre-b4096968 proxy upgraded without a reinitializer reports:
        // `_tld` is "" and `_tldNode` is 0x00…0, and both getters succeed.
        expect(isConsistentDotNsTld({ suffix: "", node: DOT_NODE })).toBe(false);
        expect(isConsistentDotNsTld({ suffix: ".", node: DOT_NODE })).toBe(false);
        expect(
            isConsistentDotNsTld({
                suffix: ".paseo",
                node: `0x${"00".repeat(32)}`,
            }),
        ).toBe(false);
    });

    test("rejects a multi-label suffix, which no deployment can have", () => {
        // `initialize` requires `tldLabel.isSingleLabel()`.
        expect(isConsistentDotNsTld({ suffix: ".a.b", node: dotNsTld(".a.b").node })).toBe(false);
    });
});
