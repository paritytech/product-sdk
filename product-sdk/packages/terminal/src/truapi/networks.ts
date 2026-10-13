// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Chain sets the truapi backend can pair on.
 *
 * Each preset names the three chains the pairing host routes to: People
 * (statement-store SSO), Bulletin (preimages) and Asset Hub (dotNS identity).
 * Values mirror `truapi-host-cli`'s `network.rs` presets so a CLI signing host
 * started with the same `--network` pairs with this backend.
 */

export interface TruapiChain {
    /** Genesis hash, `0x`-prefixed hex. */
    genesisHash: `0x${string}`;
    /** WebSocket RPC endpoint. */
    endpoint: string;
}

export interface TruapiNetwork {
    /** Network name reported to the core as the host's chain set. */
    name: string;
    people: TruapiChain;
    bulletin: TruapiChain;
    assetHub: TruapiChain;
}

export const TruapiNetworks = {
    "paseo-next-v2": {
        name: "paseo",
        people: {
            genesisHash: "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
            endpoint: "wss://paseo-people-next-system-rpc.polkadot.io",
        },
        bulletin: {
            genesisHash: "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
            endpoint: "wss://paseo-bulletin-next-rpc.polkadot.io",
        },
        assetHub: {
            genesisHash: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
            endpoint: "wss://paseo-asset-hub-next-rpc.polkadot.io",
        },
    },
} as const satisfies Record<string, TruapiNetwork>;

export type TruapiNetworkName = keyof typeof TruapiNetworks;

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("TruapiNetworks", () => {
        test("every chain has a 32-byte genesis hash and a wss endpoint", () => {
            for (const network of Object.values(TruapiNetworks)) {
                for (const chain of [network.people, network.bulletin, network.assetHub]) {
                    expect(chain.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
                    expect(chain.endpoint).toMatch(/^wss:\/\//);
                }
            }
        });

        test("genesis hashes are distinct, since the core routes by genesis", () => {
            for (const network of Object.values(TruapiNetworks)) {
                const hashes = [network.people, network.bulletin, network.assetHub].map(
                    (c) => c.genesisHash,
                );
                expect(new Set(hashes).size).toBe(3);
            }
        });
    });
}
