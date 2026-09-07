// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Guards the statement store endpoints terminal exposes.
 *
 * The endpoint names were listed in both `adapter.ts` and `index.ts` and the
 * lists drifted from the live chains (#365). These tests pin the values on the
 * public surface and pin which one the adapter defaults to, so a repointed
 * default fails here rather than at a consumer's runtime.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SS_PREVIEW_STAGE_ENDPOINTS } from "@novasamatech/host-papp";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { describe, expect, test, vi } from "vitest";

import { createTerminalAdapter, StatementStoreNetworks } from "./index.js";

// The provider is called as a function by the PAPI raw client, so the mock has
// to return one rather than a plain object.
vi.mock("@polkadot-api/ws-provider", () => ({
    getWsProvider: vi.fn(() => () => ({ send: () => {}, disconnect: () => {} })),
}));

describe("StatementStoreNetworks", () => {
    test("paseoNextV2 names the live Paseo people chain", () => {
        expect(StatementStoreNetworks.paseoNextV2).toEqual([
            "wss://paseo-people-next-system-rpc.polkadot.io",
        ]);
    });

    test("previewnet re-exposes the host-papp constant", () => {
        expect(StatementStoreNetworks.previewnet).toEqual(SS_PREVIEW_STAGE_ENDPOINTS);
    });
});

describe("createTerminalAdapter", () => {
    test("defaults to paseoNextV2 when no endpoints are given", () => {
        const storageDir = mkdtempSync(join(tmpdir(), "terminal-networks-"));

        createTerminalAdapter({ appId: "networks-test", storageDir });

        expect(getWsProvider).toHaveBeenCalledWith(
            StatementStoreNetworks.paseoNextV2,
            expect.anything(),
        );
    });
});
