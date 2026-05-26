// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
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
 * Compare two addresses for equality.
 *
 * H160 (0x-prefixed) addresses are compared case-insensitively.
 * SS58 addresses are compared exactly (base58 is case-sensitive).
 * Mixed types (SS58 vs H160) always return false - use ss58ToH160 to normalize first.
 * SS58 addresses at different prefixes (same key, different network) return false -
 * use normalizeSs58 to re-encode with the same prefix before comparing.
 */
export function addressesEqual(a: string, b: string): boolean {
    if (a === b) return true;
    // H160 addresses are hex, so case-insensitive comparison is safe
    if (a.startsWith("0x") && b.startsWith("0x")) {
        return a.toLowerCase() === b.toLowerCase();
    }
    return false;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

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
