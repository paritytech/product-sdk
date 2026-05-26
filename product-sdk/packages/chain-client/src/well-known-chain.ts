// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Genesis hashes of well-known chains.
 *
 * Mirrors `WellKnownChain` from `@novasamatech/host-api-wrapper`. Hand-copied
 * (not re-exported) so chain-client doesn't pick up a direct Novasama
 * runtime dependency; genesis hashes are immutable so drift is impossible.
 */
export const WellKnownChain = {
    polkadotRelay: "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3",
    polkadotAssetHub: "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f",
    kusamaRelay: "0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe",
    kusamaAssetHub: "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a",
    westendRelay: "0xe143f23803ac50e8f6f8e62695d1ce9e4e1d68aa36c1cd2cfd15340213f3423e",
    westendAssetHub: "0x67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9",
    rococo: "0x6408de7737c59c238890533af25896a2c20608d8b380bb01029acb392781063e",
} as const;

/** Genesis hash of a well-known chain - the value type of {@link WellKnownChain}. */
export type WellKnownChainHash = (typeof WellKnownChain)[keyof typeof WellKnownChain];

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("WellKnownChain entries are 0x-prefixed 32-byte hex strings", () => {
        for (const hash of Object.values(WellKnownChain)) {
            expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
        }
    });
}
