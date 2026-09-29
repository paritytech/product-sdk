// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The RFC-0022 derivation index: the 32-byte selector picking one account,
 * ring-VRF key or proof context out of a product's subtree.
 *
 * Shared by `@parity/product-sdk-keys` and `@parity/product-sdk-individuality`.
 * Must stay byte-identical to `individuality/support/src/context.rs` on the
 * chain and `host_logic/product_account.rs` on the host.
 *
 * @packageDocumentation
 */
import { utf8ToBytes } from "./encoding.js";
import { blake2b256 } from "./hashing.js";

/** A plain enumerable index, or 32 bytes chosen by the caller. */
export type DerivationIndex = { tag: "Index"; value: number } | { tag: "Raw"; value: Uint8Array };

const INDEX_BYTES = 32;
const U32_BYTES = 4;
const U32_MAX = 0xff_ff_ff_ff;

// Domain separation, not entropy: keeps a plain index from colliding with a Raw
// selector sharing its first four bytes. Computed so the definition is pinned.
const INDEX_MAGIC = blake2b256(utf8ToBytes("product-account-index")).subarray(
    0,
    INDEX_BYTES - U32_BYTES,
);

/**
 * Expand a {@link DerivationIndex} to the 32 bytes a soft junction consumes.
 *
 * @throws Error on an index outside `u32`, or `Raw` bytes that are not 32.
 */
export function derivationIndexBytes(index: DerivationIndex): Uint8Array {
    if (index.tag === "Raw") {
        if (index.value.length !== INDEX_BYTES) {
            throw new Error("raw derivation index must be 32 bytes");
        }
        return index.value.slice();
    }
    if (!Number.isInteger(index.value) || index.value < 0 || index.value > U32_MAX) {
        throw new Error("derivation index is out of range");
    }
    const bytes = new Uint8Array(INDEX_BYTES);
    new DataView(bytes.buffer).setUint32(0, index.value, true);
    bytes.set(INDEX_MAGIC, U32_BYTES);
    return bytes;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const hex = (bytes: Uint8Array): string =>
        `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

    describe("derivationIndexBytes", () => {
        test("pins the domain-separation magic", () => {
            expect(hex(INDEX_MAGIC)).toBe(
                "0x12e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f",
            );
        });

        test("expands Index(0) to the pinned constant", () => {
            expect(hex(derivationIndexBytes({ tag: "Index", value: 0 }))).toBe(
                "0x0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f",
            );
        });

        test("encodes the index little-endian in the first four bytes", () => {
            const bytes = derivationIndexBytes({ tag: "Index", value: 0x01_02_03_04 });
            expect(hex(bytes.subarray(0, 4))).toBe("0x04030201");
            expect(hex(bytes.subarray(4))).toBe(hex(INDEX_MAGIC));
        });

        test("passes Raw bytes through as a copy", () => {
            const raw = new Uint8Array(32).fill(7);
            const expanded = derivationIndexBytes({ tag: "Raw", value: raw });
            expect(expanded).toEqual(raw);
            expanded[0] = 0xff;
            expect(raw[0]).toBe(7);
        });

        test.each([31, 33])("rejects %i Raw bytes", (length) => {
            expect(() =>
                derivationIndexBytes({ tag: "Raw", value: new Uint8Array(length) }),
            ).toThrow(/32 bytes/);
        });

        test.each([-1, 1.5, 2 ** 32, Number.NaN])("rejects the index %s", (value) => {
            expect(() => derivationIndexBytes({ tag: "Index", value })).toThrow(/out of range/);
        });
    });
}
