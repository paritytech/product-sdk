/**
 * Entry point for the @parity/product-sdk-chain-client E2E demo.
 *
 * Wires up SignerManager (for account discovery) + preset/BYOD chain connections,
 * exposing a minimal UI that the Playwright suite drives via data-testid selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() auto-detects -> HostProvider (product-sdk)
 *   2. Host responds with Bob's non-product account
 *   3. Preset: getChainAPI("paseo") connects assetHub + bulletin + individuality
 *   4. BYOD: createChainClient({ chains: { bulletin }, rpcs: {...} }) connects bulletin
 *   5. isConnected(descriptor) verifies connection state for each chain
 *   6. Controls allow refresh and destroy operations
 */

import {
    getChainAPI,
    createChainClient,
    isConnected,
    destroyAll,
} from "@parity/product-sdk-chain-client";
import type { ChainClient, PresetChains } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { bulletin } from "@parity/product-sdk-descriptors/bulletin";
import { individuality } from "@parity/product-sdk-descriptors/individuality";
import { SignerManager } from "@parity/product-sdk-signer";

import { appendLog, getEl } from "./ui.js";

// -- DOM ------------------------------------------------------------------
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $presetStatus = getEl<HTMLSpanElement>("preset-status");
const $presetAssetHubBlock = getEl<HTMLSpanElement>("preset-asset-hub-block");
const $presetBulletinConnected = getEl<HTMLSpanElement>("preset-bulletin-connected");
const $presetIndividualityConnected = getEl<HTMLSpanElement>("preset-individuality-connected");
const $byodStatus = getEl<HTMLSpanElement>("byod-status");
const $byodBulletinBlock = getEl<HTMLSpanElement>("byod-bulletin-block");
const $btnRefreshPreset = getEl<HTMLButtonElement>("btn-refresh-preset");
const $btnDestroyPreset = getEl<HTMLButtonElement>("btn-destroy-preset");
const $log = getEl<HTMLElement>("chain-client-log");

function setControlsEnabled(enabled: boolean): void {
    $btnRefreshPreset.disabled = !enabled;
    $btnDestroyPreset.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

function updateIsConnectedDisplay(): void {
    $presetBulletinConnected.textContent = String(isConnected(bulletin));
    $presetIndividualityConnected.textContent = String(isConnected(individuality));
}

// -- App state ------------------------------------------------------------
const SS58_PREFIX = 0; // Paseo — addresses start with "1"
const APP_NAME = "chain-client-demo";

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: APP_NAME });
let presetClient: ChainClient<PresetChains<"paseo">> | null = null;
let byodClient: ChainClient<{ bulletin: typeof bulletin }> | null = null;

// -- UI subscriptions -----------------------------------------------------
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// -- Actions --------------------------------------------------------------
$btnRefreshPreset.addEventListener("click", async () => {
    if (!presetClient) return;
    setControlsEnabled(false);
    log("Refreshing preset asset hub block number...");

    try {
        const blockNumber = await presetClient.assetHub.query.System.Number.getValue();
        $presetAssetHubBlock.textContent = String(blockNumber);
        log(`Asset Hub block: ${blockNumber}`, "ok");
    } catch (err) {
        log(`Refresh failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnDestroyPreset.addEventListener("click", () => {
    if (!presetClient) return;
    setControlsEnabled(false);
    log("Destroying preset client...");

    try {
        presetClient.destroy();
        destroyAll();
        presetClient = null;
        $presetStatus.textContent = "destroyed";
        updateIsConnectedDisplay();
        log("Preset client destroyed — isConnected checks updated", "ok");
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

    // Step 2: Preset — connect all chains via getChainAPI("paseo")
    log("Connecting preset (paseo)...");
    try {
        presetClient = await getChainAPI("paseo");
        log("Preset connected", "ok");

        // Query asset hub block number
        const blockNumber = await presetClient.assetHub.query.System.Number.getValue();
        $presetAssetHubBlock.textContent = String(blockNumber);
        log(`Preset Asset Hub block: ${blockNumber}`, "ok");

        // Check isConnected for each chain
        updateIsConnectedDisplay();
        log(`isConnected(paseo_asset_hub) = ${isConnected(paseo_asset_hub)}`, "info");
        log(`isConnected(bulletin) = ${isConnected(bulletin)}`, "info");
        log(`isConnected(individuality) = ${isConnected(individuality)}`, "info");

        $presetStatus.textContent = "connected";
    } catch (err) {
        $presetStatus.textContent = "error";
        log(`Preset connection failed: ${(err as Error).message}`, "err");
    }

    // Step 3: BYOD — connect single chain (bulletin)
    log("Connecting BYOD (bulletin)...");
    try {
        byodClient = await createChainClient({
            chains: { bulletin },
            rpcs: { bulletin: ["wss://paseo-bulletin-rpc.polkadot.io"] },
        });
        log("BYOD connected", "ok");

        // Query bulletin block number
        const blockNumber = await byodClient.bulletin.query.System.Number.getValue();
        $byodBulletinBlock.textContent = String(blockNumber);
        log(`BYOD Bulletin block: ${blockNumber}`, "ok");

        $byodStatus.textContent = "connected";
    } catch (err) {
        $byodStatus.textContent = "error";
        log(`BYOD connection failed: ${(err as Error).message}`, "err");
    }

    // Step 4: Enable controls
    setControlsEnabled(true);
    log("Ready", "ok");
}

// Expose on window for e2e tests
declare global {
    interface Window {
        __CHAIN_CLIENT__: {
            isConnected: typeof isConnected;
            presetClient: typeof presetClient;
            byodClient: typeof byodClient;
            paseo_asset_hub: typeof paseo_asset_hub;
            bulletin: typeof bulletin;
            individuality: typeof individuality;
        };
    }
}

window.__CHAIN_CLIENT__ = {
    isConnected,
    get presetClient() {
        return presetClient;
    },
    get byodClient() {
        return byodClient;
    },
    paseo_asset_hub,
    bulletin,
    individuality,
};

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
