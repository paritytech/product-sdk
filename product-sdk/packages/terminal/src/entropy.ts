// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Client-side RFC-0007 product-entropy derivation for terminal (QR/SSO) sessions.
 *
 * Byte-for-byte identical to the host's `host_derive_entropy` handler — i.e.
 * `@novasamatech/host-container`'s `deriveProductEntropyFromSource` — so entropy
 * derived here matches what an in-container app gets from
 * `@parity/product-sdk-host`'s `deriveEntropy` for the same wallet + product +
 * key. Derived keys therefore interoperate across web (in-container) and
 * terminal (QR/SSO) clients.
 *
 * The paired {@link UserSession} carries `rootEntropySource` (RFC-0007 layer 1,
 * `blake2b256_keyed(rootAccountSecret, "product-entropy-derivation")`), so
 * layers 2 and 3 are computed locally with no host round-trip:
 *
 *   perProduct = blake2b256(rootEntropySource, key = blake2b256(utf8(productId)))
 *   entropy    = blake2b256(perProduct,        key = key)
 *
 * NOTE: this re-derives the RFC-0007 scheme locally and MUST stay byte-identical
 * to `host-container`'s `deriveProductEntropyFromSource`. The golden-vector test
 * below guards against drift, but the derivation ideally belongs in a shared
 * crypto package that both host-container and terminal import (see PR #260).
 *
 * @module
 */

import { blake2b } from "@noble/hashes/blake2.js";
import type { UserSession } from "@novasamatech/host-papp";

const ROOT_ENTROPY_LEN = 32;
const textEncoder = new TextEncoder();

/** BLAKE2b-256, optionally keyed — the RFC-0007 primitive. */
const b2 = (message: Uint8Array, key?: Uint8Array): Uint8Array =>
    key ? blake2b(message, { dkLen: 32, key }) : blake2b(message, { dkLen: 32 });

/**
 * Derive 32 bytes of deterministic entropy for a terminal session, scoped to the
 * calling product and a caller key (RFC-0007 layers 2 + 3).
 *
 * Same wallet + product + key ⇒ same bytes; any difference ⇒ uncorrelated
 * entropy. Because it derives from the wallet (not the device), the entropy is
 * recreatable after device loss as long as the wallet is recoverable.
 *
 * @param session   - A QR-paired {@link UserSession}. Must carry
 *   `rootEntropySource` (present since host-papp 0.8.6 / RFC-0007).
 * @param productId - The calling product's dotNS identifier, e.g. `"my-app.dot"`.
 *   The host scopes entropy per product; pass the same identifier the host would.
 * @param key       - Caller key, 1..32 bytes (the layer-3 BLAKE2b key).
 * @returns 32 bytes of derived entropy.
 * @throws if the session lacks `rootEntropySource`, or `key` is not 1..32 bytes.
 */
export function deriveEntropy(
    session: UserSession,
    productId: string,
    key: Uint8Array,
): Uint8Array {
    const rootEntropySource: Uint8Array | undefined = session.rootEntropySource;
    if (!rootEntropySource || rootEntropySource.length !== ROOT_ENTROPY_LEN) {
        throw new Error(
            "deriveEntropy: session is missing rootEntropySource; re-pair with an RFC-0007 host",
        );
    }
    if (key.length === 0 || key.length > 32) {
        throw new Error(`deriveEntropy: key must be 1..32 bytes, got ${key.length}`);
    }
    const perProduct = b2(rootEntropySource, b2(textEncoder.encode(productId)));
    return b2(perProduct, key);
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("deriveEntropy", () => {
        const rootEntropySource = new Uint8Array(32).fill(1);
        const session = { rootEntropySource } as unknown as UserSession;
        const toHex = (b: Uint8Array) =>
            Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

        test("matches host-container deriveProductEntropyFromSource (golden vector)", () => {
            // Computed with @novasamatech/host-container@0.8.9's
            // deriveProductEntropyFromSource(fill(1), "my-app.dot", [1,2,3,4]).
            expect(toHex(deriveEntropy(session, "my-app.dot", new Uint8Array([1, 2, 3, 4])))).toBe(
                "993750d5f3f4b941cef5a8084fdd0bcd6a6946fdc0e1fe87c0c575fe65e7dc03",
            );
        });

        test("is 32 bytes, deterministic, and product- and key-scoped", () => {
            const key = new Uint8Array([1, 2, 3, 4]);
            const a = deriveEntropy(session, "my-app.dot", key);
            expect(a).toHaveLength(32);
            expect(deriveEntropy(session, "my-app.dot", key)).toStrictEqual(a);
            expect(deriveEntropy(session, "other.dot", key)).not.toStrictEqual(a);
            expect(deriveEntropy(session, "my-app.dot", new Uint8Array([9]))).not.toStrictEqual(a);
        });

        test("different root entropy yields uncorrelated entropy", () => {
            const other = {
                rootEntropySource: new Uint8Array(32).fill(2),
            } as unknown as UserSession;
            const key = new Uint8Array([1, 2, 3, 4]);
            expect(deriveEntropy(other, "my-app.dot", key)).not.toStrictEqual(
                deriveEntropy(session, "my-app.dot", key),
            );
        });

        test("rejects a key outside 1..32 bytes", () => {
            expect(() => deriveEntropy(session, "my-app.dot", new Uint8Array(0))).toThrow(
                /1\.\.32/,
            );
            expect(() => deriveEntropy(session, "my-app.dot", new Uint8Array(33))).toThrow(
                /1\.\.32/,
            );
        });

        test("throws when the session has no rootEntropySource", () => {
            expect(() =>
                deriveEntropy({} as UserSession, "my-app.dot", new Uint8Array([1])),
            ).toThrow(/rootEntropySource/);
        });
    });
}
