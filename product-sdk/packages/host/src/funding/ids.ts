// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Ids that make a repeat safe. A top-up, payment request or external order
 * keyed by an id fixed by the session and the step is answered
 * `AlreadyExists` (or found again) after a restart, instead of moving funds
 * twice.
 *
 * @module
 */
import type { HexString } from "@parity/truapi";
import { blake2b256 } from "@parity/product-sdk-crypto";

import { toHex } from "../truapi.js";

const DOMAIN = "product-sdk:funding-provider:id:v1";
const encoder = new TextEncoder();

/** `bytes` prefixed with their length as a little-endian u32. */
function lengthPrefixed(bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + bytes.length);
    new DataView(out.buffer).setUint32(0, bytes.length, true);
    out.set(bytes, 4);
    return out;
}

/**
 * A 32-byte id fixed by the session and the step:
 * `blake2b-256("product-sdk:funding-provider:id:v1" ‖ len(intent) ‖ intent ‖ len(step) ‖ step)`,
 * UTF-8 with u32 little-endian lengths, so `("a", "bc")` and `("ab", "c")` differ.
 *
 * It depends on nothing saved, so even a session that lost its checkpoint
 * derives the same ids again. Steps by convention: `"topup/0"`, `"topup/1"`,
 * `"payment"`, `"refund"`, `"order"`.
 *
 * The core scopes every id it hands the host to the provider's product, so
 * the same intent and step never collide across providers.
 */
export function deriveId(intent: string, step: string): HexString {
    const parts = [
        encoder.encode(DOMAIN),
        lengthPrefixed(encoder.encode(intent)),
        lengthPrefixed(encoder.encode(step)),
    ];
    const message = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        message.set(part, offset);
        offset += part.length;
    }
    return toHex(blake2b256(message));
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("ids are stable across releases", () => {
        // Pinned: a change here would make a restarted worker start funds
        // under new ids after an upgrade.
        expect(deriveId("intent-1", "topup/0")).toBe(
            "0xcfb76bc576f3a62933a25e6f2144d5db0f77d1e752f4326848b47c02bdbaf91c",
        );
    });

    test("intent and step are length-prefixed", () => {
        expect(deriveId("a", "bc")).not.toBe(deriveId("ab", "c"));
    });

    test("each step has its own id", () => {
        expect(deriveId("i", "topup/0")).not.toBe(deriveId("i", "topup/1"));
        expect(deriveId("i", "payment")).toBe(deriveId("i", "payment"));
    });
}
