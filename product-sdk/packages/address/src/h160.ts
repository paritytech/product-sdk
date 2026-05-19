import { AccountId, type SS58String } from "@polkadot-api/substrate-bindings";
import { keccak_256 } from "@noble/hashes/sha3.js";

const EVM_DERIVED_MARKER = 0xee;
const H160_BYTE_LEN = 20;
const ACCOUNTID_BYTE_LEN = 32;

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Derive the H160 EVM address from a 32-byte Substrate public key.
 *
 * Asset Hub pallet-revive uses these derivation rules:
 * - If the account was originally EVM-derived (last 12 bytes are all 0xEE):
 *   strip the padding to recover the original H160 address.
 * - If native Substrate account (sr25519/ed25519):
 *   keccak256(publicKey), take last 20 bytes. One-way mapping.
 */
export function deriveH160(publicKey: Uint8Array): `0x${string}` {
    if (publicKey.length !== ACCOUNTID_BYTE_LEN) {
        throw new Error(
            `Expected ${ACCOUNTID_BYTE_LEN}-byte public key, got ${publicKey.length} bytes`,
        );
    }

    const isEvmDerived = publicKey.slice(H160_BYTE_LEN).every((b) => b === EVM_DERIVED_MARKER);

    if (isEvmDerived) {
        return `0x${bytesToHex(publicKey.slice(0, H160_BYTE_LEN))}`;
    }

    const hash = keccak_256(publicKey);
    return `0x${bytesToHex(hash.slice(ACCOUNTID_BYTE_LEN - H160_BYTE_LEN, ACCOUNTID_BYTE_LEN))}`;
}

/**
 * Convert an SS58 address to its H160 EVM address.
 *
 * Handles both native Substrate accounts (keccak256 path) and
 * EVM-derived accounts (0xEE padding strip).
 */
export function ss58ToH160(address: string): `0x${string}` {
    const publicKey = AccountId().enc(address as SS58String);
    return deriveH160(publicKey);
}

/**
 * Convert an H160 EVM address to its corresponding SS58 address.
 *
 * Constructs an "EVM-derived" AccountId32 by padding the H160 with 0xEE bytes.
 * These accounts are implicitly mapped in pallet-revive.
 */
export function h160ToSs58(evmAddress: string, prefix = 42): SS58String {
    const hex = evmAddress.startsWith("0x") ? evmAddress.slice(2) : evmAddress;
    if (hex.length !== H160_BYTE_LEN * 2 || !/^[a-fA-F0-9]+$/.test(hex)) {
        throw new Error(`Invalid H160 address: ${evmAddress}`);
    }

    const padded = new Uint8Array(ACCOUNTID_BYTE_LEN);
    padded.set(hexToBytes(hex), 0);
    for (let i = H160_BYTE_LEN; i < ACCOUNTID_BYTE_LEN; i++) {
        padded[i] = EVM_DERIVED_MARKER;
    }
    return AccountId(prefix).dec(padded);
}

/**
 * Convert any address (SS58 or H160) to an H160 EVM address.
 * If already H160 format (0x-prefixed, 42 chars), returns as-is preserving original casing.
 */
export function toH160(address: string): `0x${string}` {
    if (address.startsWith("0x") && address.length === 42) {
        return address as `0x${string}`;
    }
    return ss58ToH160(address);
}

/**
 * Validate whether a string is a valid H160 (20-byte hex) address.
 */
export function isValidH160(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const ALICE_PUBKEY = new Uint8Array([
        0xd4, 0x35, 0x93, 0xc7, 0x15, 0xfd, 0xd3, 0x1c, 0x61, 0x14, 0x1a, 0xbd, 0x04, 0xa9, 0x9f,
        0xd6, 0x82, 0x2c, 0x85, 0x58, 0x85, 0x4c, 0xcd, 0xe3, 0x9a, 0x56, 0x84, 0xe7, 0xa5, 0x6d,
        0xa2, 0x7d,
    ]);
    const ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const ALICE_EVM = "0x9621dde636de098b43efb0fa9b61facfe328f99d";

    describe("deriveH160", () => {
        test("derives EVM address from native sr25519 key (keccak path)", () => {
            const result = deriveH160(ALICE_PUBKEY);
            expect(result.toLowerCase()).toBe(ALICE_EVM);
        });

        test("recovers H160 from EVM-derived account (0xEE padding)", () => {
            const evmAddr = "0x1234567890abcdef1234567890abcdef12345678";
            const padded = new Uint8Array(32);
            padded.set(hexToBytes(evmAddr.slice(2)), 0);
            for (let i = 20; i < 32; i++) {
                padded[i] = 0xee;
            }
            const result = deriveH160(padded);
            expect(result.toLowerCase()).toBe(evmAddr.toLowerCase());
        });

        test("throws on wrong-length input", () => {
            expect(() => deriveH160(new Uint8Array(20))).toThrow("Expected 32-byte");
            expect(() => deriveH160(new Uint8Array(0))).toThrow("Expected 32-byte");
        });
    });

    describe("ss58ToH160", () => {
        test("converts SS58 to H160", () => {
            const result = ss58ToH160(ALICE_SS58);
            expect(result.toLowerCase()).toBe(ALICE_EVM);
        });
    });

    describe("h160ToSs58", () => {
        test("round-trips with toH160 for EVM-derived addresses", () => {
            const original = "0x9621dde636de098b43efb0fa9b61facfe328f99d";
            const ss58 = h160ToSs58(original);
            const recovered = toH160(ss58);
            expect(recovered.toLowerCase()).toBe(original.toLowerCase());
        });

        test("throws on wrong-length input", () => {
            expect(() => h160ToSs58("0x1234")).toThrow("Invalid H160");
            expect(() => h160ToSs58("not-an-address")).toThrow("Invalid H160");
        });

        test("throws on invalid hex characters", () => {
            expect(() => h160ToSs58("0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow(
                "Invalid H160",
            );
        });

        test("accepts non-default prefix", () => {
            const addr = "0x9621dde636de098b43efb0fa9b61facfe328f99d";
            const polkadot = h160ToSs58(addr, 0);
            const generic = h160ToSs58(addr, 42);
            expect(polkadot).not.toBe(generic);
            expect(toH160(polkadot)).toBe(addr);
            expect(toH160(generic)).toBe(addr);
        });
    });

    describe("toH160", () => {
        test("passes through H160 addresses preserving casing", () => {
            const checksummed = "0x9621DDE636DE098B43EFB0FA9B61FACFE328F99D";
            expect(toH160(checksummed)).toBe(checksummed);
        });

        test("converts SS58 to H160", () => {
            const result = toH160(ALICE_SS58);
            expect(result.toLowerCase()).toBe(ALICE_EVM);
        });

        test("throws for 0x-prefixed non-H160 strings", () => {
            expect(() => toH160("0x1234")).toThrow();
        });
    });

    describe("isValidH160", () => {
        test("accepts valid addresses", () => {
            expect(isValidH160("0x9621dde636de098b43efb0fa9b61facfe328f99d")).toBe(true);
            expect(isValidH160("0x0000000000000000000000000000000000000000")).toBe(true);
        });

        test("rejects invalid inputs", () => {
            expect(isValidH160("0x1234")).toBe(false);
            expect(isValidH160("not-hex")).toBe(false);
            expect(isValidH160("")).toBe(false);
            expect(isValidH160("9621dde636de098b43efb0fa9b61facfe328f99d")).toBe(false);
        });
    });
}
