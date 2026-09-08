// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The endpoint names were listed in both `adapter.ts` and `index.ts` and drifted
 * from the live chains (#365), so these pin the values and the adapter's default.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SS_PREVIEW_STAGE_ENDPOINTS } from "@novasamatech/host-papp";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { describe, expect, test, vi } from "vitest";

import { createTerminalAdapter, StatementStoreNetworks } from "./index.js";

// The PAPI raw client calls the provider, so the mock must return a function.
vi.mock("@polkadot-api/ws-provider", () => ({
    getWsProvider: vi.fn(() => () => ({ send: () => {}, disconnect: () => {} })),
}));

describe("StatementStoreNetworks", () => {
    test("paseo names the live Paseo people chain", () => {
        expect(StatementStoreNetworks.paseo).toEqual([
            "wss://paseo-people-next-system-rpc.polkadot.io",
        ]);
    });

    test("previewnet re-exposes the host-papp constant", () => {
        expect(StatementStoreNetworks.previewnet).toEqual(SS_PREVIEW_STAGE_ENDPOINTS);
    });
});

describe("createTerminalAdapter", () => {
    test("defaults to paseo when no endpoints are given", () => {
        const storageDir = mkdtempSync(join(tmpdir(), "terminal-networks-"));

        createTerminalAdapter({ appId: "networks-test", storageDir });

        expect(getWsProvider).toHaveBeenCalledWith(StatementStoreNetworks.paseo, expect.anything());
    });
});
