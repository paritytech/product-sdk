// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Maps SDK preset chain keys to the host's chain-role identifiers and holds
 * the canonical environment list. Everything here is internal to the
 * package.
 */

import type { HostChainIdentifier } from "@parity/product-sdk-host";
import type { Environment } from "./presets.js";

/** Host chain-role identifier for each preset chain key. */
export const CHAIN_IDENTIFIERS = {
    assetHub: "AssetHub",
    bulletin: "Bulletin",
    individuality: "People",
} as const satisfies Record<string, HostChainIdentifier>;

/** Every known environment. The public {@link Environment} union derives from it. */
export const ENVIRONMENTS = ["polkadot", "kusama", "paseo", "previewnet", "devnet"] as const;

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("environments are unique and individuality maps to People", () => {
        expect(new Set(ENVIRONMENTS).size).toBe(ENVIRONMENTS.length);
        // The types cannot prove the right role was picked for the one
        // non-obvious pairing.
        expect(CHAIN_IDENTIFIERS.individuality).toBe("People");
    });
}
