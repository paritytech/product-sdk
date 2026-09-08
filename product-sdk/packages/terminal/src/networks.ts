// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Statement store networks terminal can pair against, keyed as `BULLETIN_RPCS`
 * in `@parity/product-sdk-host`, where `paseo` is Paseo Next v2.
 *
 * Both sides of a pairing must sit on the same people chain. The Polkadot app's
 * nightly build uses `paseo`, which is why it is the default.
 */
import { SS_PREVIEW_STAGE_ENDPOINTS, SS_STABLE_STAGE_ENDPOINTS } from "@novasamatech/host-papp";

export const StatementStoreNetworks = {
    // host-papp has no constant for this host; its `SS_PASEO_STABLE_STAGE_ENDPOINTS`
    // still names the pre-rename chain.
    paseo: ["wss://paseo-people-next-system-rpc.polkadot.io"],
    previewnet: SS_PREVIEW_STAGE_ENDPOINTS,
} satisfies Record<string, string[]>;

/**
 * Refuses connections from outside the Parity network rather than being gone.
 * Kept exported until it has been retested on VPN (#365).
 */
export { SS_STABLE_STAGE_ENDPOINTS };

export type StatementStoreEnvironment = keyof typeof StatementStoreNetworks;

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("StatementStoreNetworks", () => {
        test("every network has at least one wss endpoint", () => {
            for (const endpoints of Object.values(StatementStoreNetworks)) {
                expect(endpoints.length).toBeGreaterThan(0);
                for (const endpoint of endpoints) {
                    expect(endpoint).toMatch(/^wss:\/\//);
                }
            }
        });

        test("paseo names the system-slot people chain", () => {
            expect(StatementStoreNetworks.paseo).toEqual([
                "wss://paseo-people-next-system-rpc.polkadot.io",
            ]);
        });
    });
}
