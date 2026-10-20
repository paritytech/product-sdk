// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The chains a terminal pairs and signs over: People (pairing and the
 * statement store), Bulletin (preimages) and Asset Hub (dotNS identity).
 * Presets match `truapi-host-cli`'s `--network` values, so the CLI signing
 * host pairs with a terminal on the same preset.
 */

export interface TerminalChain {
    genesisHash: `0x${string}`;
    endpoint: string;
}

export interface TerminalNetwork {
    /** Network name the core reports with the host's chain set. */
    name: string;
    people: TerminalChain;
    bulletin: TerminalChain;
    assetHub: TerminalChain;
}

export const TerminalNetworks = {
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
} as const satisfies Record<string, TerminalNetwork>;

export type TerminalNetworkName = keyof typeof TerminalNetworks;

export function resolveNetwork(
    network: TerminalNetworkName | TerminalNetwork = "paseo-next-v2",
): TerminalNetwork {
    if (typeof network !== "string") return network;
    const preset: TerminalNetwork | undefined = TerminalNetworks[network];
    if (!preset) throw new Error(`Unknown network "${network}"`);
    return preset;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("TerminalNetworks", () => {
        // The core routes every chain call by genesis hash, so two chains
        // sharing one would silently talk to the wrong chain.
        test("every preset names three distinct chains with wss endpoints", () => {
            for (const network of Object.values(TerminalNetworks)) {
                const chains = [network.people, network.bulletin, network.assetHub];
                expect(new Set(chains.map((chain) => chain.genesisHash)).size).toBe(3);
                for (const chain of chains) {
                    expect(chain.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
                    expect(chain.endpoint).toMatch(/^wss:\/\//);
                }
            }
        });
    });

    describe("resolveNetwork", () => {
        test("defaults to paseo-next-v2, passes a custom network through, and refuses unknown names", () => {
            const custom = { ...TerminalNetworks["paseo-next-v2"], name: "custom" };
            expect([resolveNetwork(), resolveNetwork(custom)]).toEqual([
                TerminalNetworks["paseo-next-v2"],
                custom,
            ]);
            expect(() => resolveNetwork("nope" as TerminalNetworkName)).toThrow(
                /Unknown network "nope"/,
            );
        });
    });
}
