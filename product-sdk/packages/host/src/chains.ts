// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Shared chain network configuration — single source of truth for
 * chain-specific endpoints used by multiple packages.
 */

/**
 * Bulletin Chain RPC endpoints per network environment. `paseo` and `summit`
 * are populated today; `polkadot` and `kusama` are reserved for when those
 * Bulletin deployments go live.
 */
export const BULLETIN_RPCS = {
    paseo: ["wss://paseo-bulletin-next-rpc.polkadot.io"],
    summit: ["wss://summit-bulletin-rpc.polkadot.io"],
    polkadot: [] as string[],
    kusama: [] as string[],
} as const;

/** Default Bulletin Chain endpoint — the first entry under {@link BULLETIN_RPCS}.paseo. */
export const DEFAULT_BULLETIN_ENDPOINT: string = BULLETIN_RPCS.paseo[0];

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("chains config", () => {
        test("BULLETIN_RPCS has paseo endpoint", () => {
            expect(BULLETIN_RPCS.paseo.length).toBeGreaterThan(0);
            expect(BULLETIN_RPCS.paseo[0]).toMatch(/^wss:\/\//);
        });

        test("BULLETIN_RPCS has summit endpoint", () => {
            expect(BULLETIN_RPCS.summit.length).toBeGreaterThan(0);
            expect(BULLETIN_RPCS.summit[0]).toMatch(/^wss:\/\//);
        });

        test("BULLETIN_RPCS polkadot and kusama are empty until live", () => {
            expect(BULLETIN_RPCS.polkadot).toEqual([]);
            expect(BULLETIN_RPCS.kusama).toEqual([]);
        });

        test("DEFAULT_BULLETIN_ENDPOINT matches first paseo endpoint", () => {
            expect(DEFAULT_BULLETIN_ENDPOINT).toBe(BULLETIN_RPCS.paseo[0]);
        });
    });
}
