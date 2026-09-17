// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { getSs58AddressInfo, type SS58String } from "@polkadot-api/substrate-bindings";

/**
 * Truncate an address for display.
 *
 * @param address - Full address (SS58 or H160)
 * @param startChars - Characters to show at the start (default 6)
 * @param endChars - Characters to show at the end (default 4)
 * @returns Truncated string like "5Grwva...utQY"
 */
export function truncateAddress(address: string, startChars = 6, endChars = 4): string {
    if (!address) return "";
    const minLength = startChars + endChars + 3; // 3 for "..."
    if (address.length <= minLength) return address;
    return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Do two addresses name the same account?
 *
 * **On the account, not on the encoding.** Two SS58 strings for one key are equal
 * even at different network prefixes, so this cannot tell you which network an
 * address is written for; read the prefix from {@link ss58Decode} for that. An
 * SS58 and an H160 are never equal, whatever they encode.
 *
 * A non-matching pair costs a decode, roughly 20 microseconds, where an exact
 * match costs nothing. In a loop, use {@link publicKeysEqual} instead.
 */
export function addressesEqual(a: string, b: string): boolean {
    if (a === b) return true;
    if (a.startsWith("0x") && b.startsWith("0x")) {
        return a.toLowerCase() === b.toLowerCase();
    }
    // Base58 is case-significant, so lowercasing an SS58 address invalidates its
    // checksum rather than normalising it. Decoding is the only correct test.
    const left = getSs58AddressInfo(a as SS58String);
    const right = getSs58AddressInfo(b as SS58String);
    // An invalid address equals nothing, and an exact match was handled above.
    if (!left.isValid || !right.isValid) return false;
    return publicKeysEqual(left.publicKey, right.publicKey);
}

/**
 * Do two public keys match? The loop half of {@link addressesEqual}: decode the
 * needle once with {@link ss58Decode}, then compare it against each candidate.
 *
 * A byte comparison, so both inputs must already have decoded successfully. Two
 * empty arrays compare equal. Unvalidated on purpose, since this runs per
 * candidate.
 */
export function publicKeysEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("addressesEqual", () => {
        const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

        // Alice's key written for the generic prefix and for Polkadot. Literals
        // rather than derived, so the test pins the encodings themselves.
        const ALICE_POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";

        test("the same account under two network prefixes is equal", () => {
            expect(ALICE_POLKADOT).not.toBe(ALICE);
            expect(addressesEqual(ALICE, ALICE_POLKADOT)).toBe(true);
        });

        test("different accounts are not equal", () => {
            const other = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
            expect(addressesEqual(ALICE, other)).toBe(false);
        });

        test("identical strings are equal without decoding", () => {
            expect(addressesEqual(ALICE, ALICE)).toBe(true);
        });

        test("H160 stays case-insensitive", () => {
            expect(
                addressesEqual(
                    "0x9621dde636de098b43efb0fa9b61facfe328f99d",
                    "0x9621DDE636DE098B43EFB0FA9B61FACFE328F99D",
                ),
            ).toBe(true);
        });

        test("so it cannot be used as a network check", () => {
            // Recorded because the previous behaviour was usable as a rough
            // network check and this is no longer that.
            expect(addressesEqual(ALICE, ALICE_POLKADOT)).toBe(true);
        });

        test("a malformed address is not equal to a valid one, and does not throw", () => {
            expect(addressesEqual(ALICE, "not-an-address")).toBe(false);
            expect(addressesEqual("not-an-address", "also-not")).toBe(false);
        });
    });

    describe("publicKeysEqual", () => {
        test("matches equal keys and rejects different ones", () => {
            const a = new Uint8Array([1, 2, 3]);
            expect(publicKeysEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
            expect(publicKeysEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
        });

        test("different lengths are not equal, and do not read past the end", () => {
            expect(publicKeysEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
            expect(publicKeysEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
        });

        test("agrees with addressesEqual for one account under two prefixes", async () => {
            // The documented escape hatch for a loop: decode once, compare keys.
            const { ss58Decode } = await import("./ss58.js");
            const generic = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
            const polkadot = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
            expect(
                publicKeysEqual(ss58Decode(generic).publicKey, ss58Decode(polkadot).publicKey),
            ).toBe(addressesEqual(generic, polkadot));
        });
    });

    describe("truncateAddress", () => {
        test("truncates with defaults", () => {
            const addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
            expect(truncateAddress(addr)).toBe("5Grwva...utQY");
        });

        test("truncates with custom lengths", () => {
            const addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
            expect(truncateAddress(addr, 4, 3)).toBe("5Grw...tQY");
        });

        test("returns short addresses unchanged", () => {
            expect(truncateAddress("5Grw")).toBe("5Grw");
            expect(truncateAddress("")).toBe("");
        });

        test("works with H160", () => {
            const addr = "0x9621dde636de098b43efb0fa9b61facfe328f99d";
            expect(truncateAddress(addr, 6, 4)).toBe("0x9621...f99d");
        });
    });

    describe("addressesEqual", () => {
        test("exact match", () => {
            const addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
            expect(addressesEqual(addr, addr)).toBe(true);
        });

        test("H160 case-insensitive", () => {
            expect(
                addressesEqual(
                    "0x9621DDE636DE098B43EFB0FA9B61FACFE328F99D",
                    "0x9621dde636de098b43efb0fa9b61facfe328f99d",
                ),
            ).toBe(true);
        });

        test("returns false for different addresses", () => {
            expect(
                addressesEqual(
                    "0x9621dde636de098b43efb0fa9b61facfe328f99d",
                    "0x0000000000000000000000000000000000000000",
                ),
            ).toBe(false);
        });

        test("returns false for different SS58 addresses", () => {
            expect(
                addressesEqual(
                    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                    "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
                ),
            ).toBe(false);
        });

        test("returns false for mixed types (SS58 vs H160)", () => {
            expect(
                addressesEqual(
                    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
                    "0x9621dde636de098b43efb0fa9b61facfe328f99d",
                ),
            ).toBe(false);
        });
    });
}
