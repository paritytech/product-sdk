// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point for the @parity/product-sdk-chain-client E2E demo.
 *
 * Wires up SignerManager (for account discovery) + chain connections,
 * exposing a minimal UI that the Playwright suite drives via data-testid selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() auto-detects -> HostProvider (product-sdk)
 *   2. Host responds with Bob's non-product account
 *   3. BYOD: createChainClient({ chains: { assetHub } }) connects via host
 *   4. isConnected(descriptor) verifies connection state
 *   5. Controls allow refresh and destroy operations
 *
 * Note: The SDK is designed for container-only usage. The test host mock provides
 * chain connections via the host API - no fallback to direct WebSocket.
 */

import { createChainClient, isConnected, destroyAll } from "@parity/product-sdk-chain-client";
import type { ChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { SignerManager } from "@parity/product-sdk-signer";

import { appendLog, getEl } from "./ui.js";

// -- DOM ------------------------------------------------------------------
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $byodStatus = getEl<HTMLSpanElement>("byod-status");
const $byodAssetHubBlock = getEl<HTMLSpanElement>("byod-asset-hub-block");
const $byodAssetHubConnected = getEl<HTMLSpanElement>("byod-asset-hub-connected");
const $btnRefresh = getEl<HTMLButtonElement>("btn-refresh");
const $btnDestroy = getEl<HTMLButtonElement>("btn-destroy");
const $log = getEl<HTMLElement>("chain-client-log");

function setControlsEnabled(enabled: boolean): void {
    $btnRefresh.disabled = !enabled;
    $btnDestroy.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

function updateIsConnectedDisplay(): void {
    $byodAssetHubConnected.textContent = String(isConnected(paseo_asset_hub));
}

// -- App state ------------------------------------------------------------
const SS58_PREFIX = 0; // Paseo — addresses start with "1"
const APP_NAME = "chain-client-demo";

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: APP_NAME });
let byodClient: ChainClient<{ assetHub: typeof paseo_asset_hub }> | null = null;

// -- UI subscriptions -----------------------------------------------------
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// -- Actions --------------------------------------------------------------
$btnRefresh.addEventListener("click", async () => {
    if (!byodClient) return;
    setControlsEnabled(false);
    log("Refreshing asset hub block number...");

    try {
        const blockNumber = await byodClient.assetHub.query.System.Number.getValue();
        $byodAssetHubBlock.textContent = String(blockNumber);
        log(`Asset Hub block: ${blockNumber}`, "ok");
    } catch (err) {
        log(`Refresh failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnDestroy.addEventListener("click", () => {
    if (!byodClient) return;
    setControlsEnabled(false);
    log("Destroying client...");

    try {
        byodClient.destroy();
        destroyAll();
        byodClient = null;
        $byodStatus.textContent = "destroyed";
        updateIsConnectedDisplay();
        log("Client destroyed — isConnected checks updated", "ok");
    } catch (err) {
        log(`Destroy failed: ${(err as Error).message}`, "err");
        setControlsEnabled(true);
    }
});

// -- Boot -----------------------------------------------------------------
async function init() {
    log("Booting chain-client-demo...");

    // Step 1: connect signer (HostProvider inside the test host)
    log("Connecting signer...");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        log(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }
    const accounts = connectRes.value;
    if (accounts.length === 0) {
        log("No accounts exposed by the host", "err");
        return;
    }
    const selectRes = manager.selectAccount(accounts[0].address);
    if (!selectRes.ok) {
        log(`selectAccount failed: ${selectRes.error.message}`, "err");
        return;
    }
    const address = accounts[0].address;
    log(`Signer ready: ${address}`, "ok");

    // Step 2: BYOD — connect single chain (asset hub) via host provider
    log("Connecting BYOD (asset hub)...");
    try {
        byodClient = await createChainClient({
            chains: { assetHub: paseo_asset_hub },
        });
        log("BYOD connected", "ok");

        // Query asset hub block number
        const blockNumber = await byodClient.assetHub.query.System.Number.getValue();
        $byodAssetHubBlock.textContent = String(blockNumber);
        log(`Asset Hub block: ${blockNumber}`, "ok");

        // Check isConnected
        updateIsConnectedDisplay();
        log(`isConnected(paseo_asset_hub) = ${isConnected(paseo_asset_hub)}`, "info");

        $byodStatus.textContent = "connected";
    } catch (err) {
        $byodStatus.textContent = "error";
        log(`BYOD connection failed: ${(err as Error).message}`, "err");
    }

    // Step 3: Enable controls
    setControlsEnabled(true);
    log("Ready", "ok");
}

// Expose on window for e2e tests
declare global {
    interface Window {
        __CHAIN_CLIENT__: {
            isConnected: typeof isConnected;
            byodClient: typeof byodClient;
            paseo_asset_hub: typeof paseo_asset_hub;
        };
    }
}

window.__CHAIN_CLIENT__ = {
    isConnected,
    get byodClient() {
        return byodClient;
    },
    paseo_asset_hub,
};

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
