// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { bytesToHex, keccak256 } from "@parity/product-sdk-crypto";
import { describe, expect, test } from "vitest";
import { DOT_NODE, namehash } from "./dotns-namehash.js";

// Independent reference implementation of the same algorithm, so the test
// pins behaviour rather than restating the code.
function hexBytes(hex: string): Uint8Array {
    const pairs = hex.slice(2).match(/.{2}/g) ?? [];
    return Uint8Array.from(pairs.map((b) => Number.parseInt(b, 16)));
}

function refNamehash(name: string): string {
    const trimmed = name.endsWith(".dot") ? name.slice(0, -4) : name;
    const labels = trimmed === "" ? [] : trimmed.split(".");
    let node = hexBytes(DOT_NODE);
    for (let i = labels.length - 1; i >= 0; i--) {
        const lh = keccak256(new TextEncoder().encode(labels[i]));
        const combined = new Uint8Array(64);
        combined.set(node, 0);
        combined.set(lh, 32);
        node = keccak256(combined);
    }
    return `0x${bytesToHex(node)}`;
}

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
        expect(namehash(".dot")).toBe(DOT_NODE);
        expect(namehash("")).toBe(DOT_NODE);
    });

    test("normalizes the same with or without the .dot suffix", () => {
        expect(namehash("alice.dot")).toBe(namehash("alice"));
    });

    test("matches the reference algorithm for single + sub labels", () => {
        expect(namehash("alice.dot")).toBe(refNamehash("alice.dot"));
        expect(namehash("bob.alice.dot")).toBe(refNamehash("bob.alice.dot"));
    });

    test("distinct names produce distinct nodes", () => {
        expect(namehash("alice.dot")).not.toBe(namehash("bob.dot"));
    });

    test("returns a 32-byte 0x-hex string", () => {
        expect(namehash("alice.dot")).toMatch(/^0x[0-9a-f]{64}$/);
    });
});
