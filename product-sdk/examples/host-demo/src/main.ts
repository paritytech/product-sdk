/**
 * Entry point for the @parity/product-sdk-host E2E demo.
 *
 * Wires up SignerManager (for account discovery) + host container detection +
 * host localStorage, exposing a minimal UI that the Playwright suite drives
 * via data-testid selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() auto-detects -> HostProvider (product-sdk)
 *   2. Host responds with Bob's non-product account
 *   3. isInsideContainer() -> true (product-sdk sandbox detection)
 *   4. isInsideContainerSync() -> true (iframe heuristic)
 *   5. getHostLocalStorage() -> HostLocalStorage instance
 *   6. Storage buttons drive read/write/clear operations
 */

import { isInsideContainer, isInsideContainerSync, getHostLocalStorage } from "@parity/product-sdk-host";
import type { HostLocalStorage } from "@parity/product-sdk-host";
import { SignerManager } from "@parity/product-sdk-signer";

import { appendLog, getEl } from "./ui.js";

// -- DOM ------------------------------------------------------------------
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $containerStatus = getEl<HTMLSpanElement>("container-status");
const $containerSyncStatus = getEl<HTMLSpanElement>("container-sync-status");
const $hostStorageStatus = getEl<HTMLSpanElement>("host-storage-status");
const $storageKeyInput = getEl<HTMLInputElement>("storage-key-input");
const $storageValueInput = getEl<HTMLInputElement>("storage-value-input");
const $btnWriteString = getEl<HTMLButtonElement>("btn-write-string");
const $btnReadString = getEl<HTMLButtonElement>("btn-read-string");
const $btnWriteJson = getEl<HTMLButtonElement>("btn-write-json");
const $btnReadJson = getEl<HTMLButtonElement>("btn-read-json");
const $btnClear = getEl<HTMLButtonElement>("btn-clear");
const $lastReadValue = getEl<HTMLElement>("last-read-value");
const $log = getEl<HTMLElement>("host-log");

function setControlsEnabled(enabled: boolean): void {
    $storageKeyInput.disabled = !enabled;
    $storageValueInput.disabled = !enabled;
    $btnWriteString.disabled = !enabled;
    $btnReadString.disabled = !enabled;
    $btnWriteJson.disabled = !enabled;
    $btnReadJson.disabled = !enabled;
    $btnClear.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

// -- App state ------------------------------------------------------------
const SS58_PREFIX = 0; // Paseo — addresses start with "1"
const APP_NAME = "host-demo";

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: APP_NAME });
let hostStorage: HostLocalStorage | null = null;

// -- UI subscriptions -----------------------------------------------------
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// -- Actions --------------------------------------------------------------
$btnWriteString.addEventListener("click", async () => {
    if (!hostStorage) return;
    const key = $storageKeyInput.value || "test-key";
    const value = $storageValueInput.value || "hello";
    setControlsEnabled(false);
    log(`Writing string: "${key}" = "${value}"...`);

    try {
        await hostStorage.writeString(key, value);
        log(`writeString("${key}") success`, "ok");
    } catch (err) {
        log(`writeString failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnReadString.addEventListener("click", async () => {
    if (!hostStorage) return;
    const key = $storageKeyInput.value || "test-key";
    setControlsEnabled(false);
    log(`Reading string: "${key}"...`);

    try {
        const result = await hostStorage.readString(key);
        // Host returns undefined or "" for missing keys — normalize both to "null"
        const display = result != null && result !== "" ? result : "null";
        $lastReadValue.textContent = display;
        log(`readString("${key}") = ${display}`, "ok");
    } catch (err) {
        log(`readString failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnWriteJson.addEventListener("click", async () => {
    if (!hostStorage) return;
    const key = $storageKeyInput.value || "test-key";
    const value = $storageValueInput.value || "hello";
    const payload = { text: value, n: 42 };
    setControlsEnabled(false);
    log(`Writing JSON: "${key}" = ${JSON.stringify(payload)}...`);

    try {
        await hostStorage.writeJSON(key, payload);
        log(`writeJSON("${key}") success`, "ok");
    } catch (err) {
        log(`writeJSON failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnReadJson.addEventListener("click", async () => {
    if (!hostStorage) return;
    const key = $storageKeyInput.value || "test-key";
    setControlsEnabled(false);
    log(`Reading JSON: "${key}"...`);

    try {
        const result = await hostStorage.readJSON(key);
        const display = result != null ? JSON.stringify(result) : "null";
        $lastReadValue.textContent = display;
        log(`readJSON("${key}") = ${display}`, "ok");
    } catch (err) {
        log(`readJSON failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnClear.addEventListener("click", async () => {
    if (!hostStorage) return;
    const key = $storageKeyInput.value || "test-key";
    setControlsEnabled(false);
    log(`Clearing key: "${key}"...`);

    try {
        await hostStorage.clear(key);
        log(`clear("${key}") success`, "ok");
    } catch (err) {
        log(`clear failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// -- Boot -----------------------------------------------------------------
async function init() {
    log("Booting host-demo...");

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

    // Step 2: container detection (async)
    log("Detecting container...");
    const inContainer = await isInsideContainer();
    $containerStatus.textContent = String(inContainer);
    log(`isInsideContainer() = ${inContainer}`, inContainer ? "ok" : "info");

    // Step 3: container detection (sync)
    const inContainerSync = isInsideContainerSync();
    $containerSyncStatus.textContent = String(inContainerSync);
    log(`isInsideContainerSync() = ${inContainerSync}`, inContainerSync ? "ok" : "info");

    // Step 4: host localStorage
    log("Getting host localStorage...");
    hostStorage = await getHostLocalStorage();
    $hostStorageStatus.textContent = hostStorage ? "available" : "null";
    log(`getHostLocalStorage() = ${hostStorage ? "available" : "null"}`, hostStorage ? "ok" : "info");

    // Step 5: enable controls if host storage is available
    if (hostStorage) {
        setControlsEnabled(true);
        log("Ready", "ok");
    } else {
        log("Host storage not available — controls disabled", "info");
    }
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
