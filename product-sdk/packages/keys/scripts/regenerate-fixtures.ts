// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Maintenance tool: print the four hex vectors that lock
 * deriveProductAccountPublicKey to its canonical output.
 *
 * Run if polkadot-desktop's productAccountService changes its derivation
 * algorithm and we need to re-confirm parity:
 *
 *   npx tsx packages/keys/scripts/regenerate-fixtures.ts
 *
 * Then paste the printed hex values into
 * packages/keys/src/product-account.test.ts and verify the test still
 * passes against the new vectors. If parity has broken, surface that in
 * a follow-up issue before committing.
 *
 * Parent public keys are derived from deterministic 32-byte seeds via
 * @scure/sr25519's `secretFromSeed` + `getPublicKey`. Arbitrary 32-byte
 * buffers do not work as parent keys: HDKD.publicSoft validates the
 * Ristretto255 encoding at the entry point and rejects non-curve points.
 *
 * This script is NOT run in CI.
 */

import { getPublicKey, secretFromSeed } from "@scure/sr25519";
import { deriveProductAccountPublicKey } from "../src/product-account.js";

function toHex(bytes: Uint8Array): string {
    return `0x${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
}

function pubKeyFromSeedByte(byte: number): Uint8Array {
    const seed = new Uint8Array(32).fill(byte);
    return getPublicKey(secretFromSeed(seed));
}

const cases = [
    {
        seedByte: 0,
        productId: "playground.dot",
        index: 0,
        label: "playground.dot/0, parent pubkey from seed byte 0x00",
    },
    {
        seedByte: 1,
        productId: "playground.dot",
        index: 1,
        label: "playground.dot/1, parent pubkey from seed byte 0x01",
    },
    {
        seedByte: 2,
        productId: "a-very-long-product.dot",
        index: 0,
        label: "a-very-long-product.dot/0, parent pubkey from seed byte 0x02",
    },
    {
        seedByte: 3,
        productId: "this-name-is-deliberately-long-enough-to-trip-the-fallback.dot",
        index: 0,
        label: "long-fallback-name/0, parent pubkey from seed byte 0x03",
    },
];

for (const c of cases) {
    const parent = pubKeyFromSeedByte(c.seedByte);
    const out = deriveProductAccountPublicKey(parent, c.productId, c.index);
    console.log(
        `${c.label}\n  productId: ${c.productId}\n  index:     ${c.index}\n  seedByte:  0x${c.seedByte.toString(16).padStart(2, "0")}\n  expected:  ${toHex(out)}\n`,
    );
}
