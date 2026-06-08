// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Statement Store value types and helpers.
 *
 * The statement shapes are **derived** from the in-house `@parity/truapi` wire
 * types (re-exported by `@parity/product-sdk-host`) rather than hand-redefined,
 * so changes to the protocol's statement definition propagate automatically.
 * The single intentional difference is `data`: this SDK layer works with decoded
 * `Uint8Array` bytes, whereas the wire type carries a hex string. {@link Proof}
 * and {@link Topic} are re-exported verbatim. The host transport bridges the
 * `data` field (and the ergonomic {@link TopicFilter}).
 *
 * @module
 */

import type {
    SignedStatement as WireSignedStatement,
    Statement as WireStatement,
} from "@parity/product-sdk-host";

/** A `0x`-prefixed hex string. */
export type Hex = `0x${string}`;

/**
 * Signature attached to a statement — `Sr25519`/`Ed25519`/`Ecdsa` plus public
 * key, or an `OnChain` witness referencing a block event. Re-exported from the
 * truapi wire types (`{ tag }` discriminant, hex fields).
 */
export type { StatementProof as Proof, Topic } from "@parity/product-sdk-host";

/**
 * A record published to the Statement Store. Derived from the truapi wire
 * {@link WireStatement}, overriding only `data` to carry decoded `Uint8Array`
 * bytes instead of a hex string. Other fields (`topics`, `channel`,
 * `decryptionKey`, `expiry`, `proof`) inherit from the wire type.
 */
export type Statement = Omit<WireStatement, "data"> & { data?: Uint8Array };

/** A {@link Statement} before signing — the same fields, minus `proof`. */
export type UnsignedStatement = Omit<Statement, "proof">;

/** A {@link Statement} with its `proof` attached and ready for submission. Derived from the truapi wire signed statement, with decoded `data`. */
export type SignedStatement = Omit<WireSignedStatement, "data"> & { data?: Uint8Array };

/**
 * Filter for subscribing to statements.
 *
 * - `"any"` — match all statements.
 * - `{ matchAll }` — statement must contain **every** listed topic.
 * - `{ matchAny }` — statement must contain **at least one** listed topic.
 */
export type TopicFilter = "any" | { matchAll: Hex[] } | { matchAny: Hex[] };

/**
 * Create an expiry value from a timestamp and sequence number.
 *
 * Packs the Unix timestamp (seconds) into the upper 32 bits and the sequence
 * number into the lower 32 bits of a `u64`.
 *
 * @param expirationTimestampSecs - Expiration time in seconds since the UNIX epoch.
 * @param sequenceNumber - Sequence number for ordering within a second (0–4294967295).
 */
export function createExpiry(expirationTimestampSecs: number, sequenceNumber = 0): bigint {
    if (sequenceNumber < 0 || sequenceNumber > 4_294_967_295) {
        throw new RangeError("sequenceNumber must be 0-4294967295");
    }
    return (BigInt(expirationTimestampSecs) << 32n) | BigInt(sequenceNumber);
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("createExpiry packs timestamp into the upper 32 bits and sequence into the lower", () => {
        expect(createExpiry(1, 0)).toBe(1n << 32n);
        expect(createExpiry(0, 5)).toBe(5n);
        expect(createExpiry(2, 3)).toBe((2n << 32n) | 3n);
    });

    test("createExpiry rejects out-of-range sequence numbers", () => {
        expect(() => createExpiry(1, -1)).toThrow(RangeError);
        expect(() => createExpiry(1, 4_294_967_296)).toThrow(RangeError);
    });
}
