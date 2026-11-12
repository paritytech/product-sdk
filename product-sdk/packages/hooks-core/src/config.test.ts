// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { defineConfig, resolveChain } from "./config.js";

const descriptor = {} as ChainDefinition;
const GENESIS = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

describe("defineConfig", () => {
    it("rejects an empty chain map", () => {
        expect(() => defineConfig({ chains: {} })).toThrow(/at least one chain/);
    });

    it("returns the config unchanged", () => {
        const config = defineConfig({ chains: { assetHub: { descriptor, genesisHash: GENESIS } } });
        expect(config.chains.assetHub.genesisHash).toBe(GENESIS);
    });
});

describe("resolveChain", () => {
    const config = defineConfig({
        chains: {
            assetHub: { descriptor, genesisHash: GENESIS },
            bulletin: { descriptor, genesisHash: "0x22" as `0x${string}` },
        },
        defaultChain: "bulletin",
    });

    it("resolves an explicit key", () => {
        expect(resolveChain(config, "assetHub").key).toBe("assetHub");
    });

    it("falls back to defaultChain", () => {
        expect(resolveChain(config).key).toBe("bulletin");
    });

    it("falls back to the first chain without defaultChain", () => {
        const first = defineConfig({ chains: { only: { descriptor, genesisHash: GENESIS } } });
        expect(resolveChain(first).key).toBe("only");
    });

    it("throws with the configured keys on unknown chain", () => {
        expect(() => resolveChain(config, "nope" as never)).toThrow(/assetHub, bulletin/);
    });
});
