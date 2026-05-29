// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    AccountId,
    fromBufferToBase58,
    getSs58AddressInfo,
    type SS58String,
} from "@polkadot-api/substrate-bindings";

const GENERIC_PREFIX = 42;
const POLKADOT_PREFIX = 0;

/**
 * Validate whether a string is a valid SS58 address.
 */
export function isValidSs58(address: string): boolean {
    try {
        const info = getSs58AddressInfo(address as SS58String);
        return info.isValid;
    } catch {
        return false;
    }
}

/**
 * Decode an SS58 address into its raw public key bytes and network prefix.
 */
export function ss58Decode(address: string): { publicKey: Uint8Array; prefix: number } {
    const info = getSs58AddressInfo(address as SS58String);
    if (!info.isValid) {
        throw new Error(`Invalid SS58 address: ${address}`);
    }
    return { publicKey: info.publicKey, prefix: info.ss58Format };
}

/**
 * Encode raw public key bytes into an SS58 address with the given prefix.
 * Defaults to prefix 42 (generic Substrate).
 */
export function ss58Encode(publicKey: Uint8Array, prefix: number = GENERIC_PREFIX): SS58String {
    return fromBufferToBase58(prefix)(publicKey);
}

/**
 * Re-encode an SS58 address with a different network prefix.
 * Returns null if the input is not a valid SS58 address.
 */
export function normalizeSs58(address: string, prefix: number = GENERIC_PREFIX): SS58String | null {
    try {
        const { publicKey } = ss58Decode(address);
        return ss58Encode(publicKey, prefix);
    } catch {
        return null;
    }
}

/**
 * Convert any SS58 address to generic Substrate format (prefix 42).
 * Returns null if the input is invalid.
 */
export function toGenericSs58(address: string): SS58String | null {
    return normalizeSs58(address, GENERIC_PREFIX);
}

/**
 * Convert any SS58 address to Polkadot format (prefix 0).
 * Returns null if the input is invalid.
 */
export function toPolkadotSs58(address: string): SS58String | null {
    return normalizeSs58(address, POLKADOT_PREFIX);
}

/**
 * Encode an SS58 address from a 32-byte public key using polkadot-api's AccountId codec.
 * This is the inverse of `accountIdBytes()`.
 */
export function accountIdFromBytes(
    publicKey: Uint8Array,
    prefix: number = GENERIC_PREFIX,
): SS58String {
    return AccountId(prefix).dec(publicKey);
}

/**
 * Decode an SS58 address to its 32-byte AccountId using polkadot-api's AccountId codec.
 * This is the inverse of `accountIdFromBytes()`.
 */
export function accountIdBytes(address: string): Uint8Array {
    return AccountId().enc(address as SS58String);
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const ALICE_PUBKEY = new Uint8Array([
        0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9, 0x9f,
        0xd6, 0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7, 0xa5, 0x6d,
        0xa2, 0x7d,
    ]);

    describe("isValidSs58", () => {
        test("accepts valid addresses", () => {
            expect(isValidSs58(ALICE_SS58)).toBe(true);
        });

        test("rejects garbage", () => {
            expect(isValidSs58("not-an-address")).toBe(false);
            expect(isValidSs58("")).toBe(false);
            expect(isValidSs58("0x1234")).toBe(false);
        });
    });

    describe("ss58Decode", () => {
        test("returns public key and prefix", () => {
            const { publicKey, prefix } = ss58Decode(ALICE_SS58);
            expect(publicKey).toEqual(ALICE_PUBKEY);
            expect(prefix).toBe(42);
        });

        test("throws on invalid input", () => {
            expect(() => ss58Decode("garbage")).toThrow();
        });
    });

    describe("ss58Encode", () => {
        test("produces valid address with default prefix", () => {
            expect(ss58Encode(ALICE_PUBKEY, 42)).toBe(ALICE_SS58);
        });

        test("round-trips with ss58Decode at prefix 0", () => {
            const encoded = ss58Encode(ALICE_PUBKEY, 0);
            const { publicKey, prefix } = ss58Decode(encoded);
            expect(publicKey).toEqual(ALICE_PUBKEY);
            expect(prefix).toBe(0);
        });
    });

    describe("normalizeSs58", () => {
        test("re-encodes with target prefix", () => {
            const polkadot = normalizeSs58(ALICE_SS58, 0);
            expect(polkadot).not.toBeNull();
            expect(polkadot).not.toBe(ALICE_SS58);
            const generic = normalizeSs58(polkadot!, 42);
            expect(generic).toBe(ALICE_SS58);
        });

        test("returns null on invalid input", () => {
            expect(normalizeSs58("garbage")).toBeNull();
        });
    });

    describe("toGenericSs58", () => {
        test("converts Polkadot-prefix address to prefix 42", () => {
            const polkadot = normalizeSs58(ALICE_SS58, 0)!;
            expect(toGenericSs58(polkadot)).toBe(ALICE_SS58);
        });

        test("returns null for invalid input", () => {
            expect(toGenericSs58("not-an-address")).toBeNull();
        });
    });

    describe("toPolkadotSs58", () => {
        test("converts generic SS58 to Polkadot prefix 0", () => {
            const result = toPolkadotSs58(ALICE_SS58);
            expect(result).not.toBeNull();
            expect(toGenericSs58(result!)).toBe(ALICE_SS58);
        });

        test("returns null for invalid input", () => {
            expect(toPolkadotSs58("not-an-address")).toBeNull();
        });
    });

    describe("accountId round-trip", () => {
        test("accountIdFromBytes and accountIdBytes", () => {
            const address = accountIdFromBytes(ALICE_PUBKEY);
            const bytes = accountIdBytes(address);
            expect(bytes).toEqual(ALICE_PUBKEY);
        });

        test("accountIdFromBytes with custom prefix", () => {
            const generic = accountIdFromBytes(ALICE_PUBKEY, 42);
            const polkadot = accountIdFromBytes(ALICE_PUBKEY, 0);
            expect(generic).toBe(ALICE_SS58);
            expect(polkadot).not.toBe(ALICE_SS58);
            expect(accountIdBytes(generic)).toEqual(ALICE_PUBKEY);
            expect(accountIdBytes(polkadot)).toEqual(ALICE_PUBKEY);
        });
    });
}
