/**
 * Entry point for the @parity/product-sdk-storage E2E demo.
 *
 * Wires up SignerManager (for account discovery) + KvStore auto-detection,
 * exposing a minimal UI that the Playwright suite drives via data-testid
 * selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() auto-detects → HostProvider (product-sdk)
 *   2. Host responds with Bob's non-product account
 *   3. isInsideContainer() → true (inside test host iframe)
 *   4. createKvStore() → host backend (via getHostLocalStorage())
 *   5. createKvStore({ prefix: "demo" }) → prefixed host backend
 *
 * The test SDK backs host localStorage with browser localStorage using
 * a "test-host:" prefix. So store.set("mykey", "val") results in the
 * host page having localStorage.getItem("test-host:mykey") === "val".
 */

import { isInsideContainer } from "@parity/product-sdk-host";
import { SignerManager } from "@parity/product-sdk-signer";
import { createKvStore } from "@parity/product-sdk-storage";
import type { KvStore } from "@parity/product-sdk-storage";

import { appendLog, getEl } from "./ui.js";

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $backendType = getEl<HTMLSpanElement>("backend-type");
const $storeStatus = getEl<HTMLSpanElement>("store-status");
const $kvKeyInput = getEl<HTMLInputElement>("kv-key-input");
const $kvValueInput = getEl<HTMLInputElement>("kv-value-input");
const $btnSet = getEl<HTMLButtonElement>("btn-set");
const $btnGet = getEl<HTMLButtonElement>("btn-get");
const $btnSetJson = getEl<HTMLButtonElement>("btn-set-json");
const $btnGetJson = getEl<HTMLButtonElement>("btn-get-json");
const $btnRemove = getEl<HTMLButtonElement>("btn-remove");
const $lastGetValue = getEl<HTMLSpanElement>("last-get-value");
const $btnSetPrefixed = getEl<HTMLButtonElement>("btn-set-prefixed");
const $btnGetPrefixed = getEl<HTMLButtonElement>("btn-get-prefixed");
const $prefixedGetValue = getEl<HTMLSpanElement>("prefixed-get-value");
const $log = getEl<HTMLElement>("storage-log");

function setControlsEnabled(enabled: boolean): void {
    $kvKeyInput.disabled = !enabled;
    $kvValueInput.disabled = !enabled;
    $btnSet.disabled = !enabled;
    $btnGet.disabled = !enabled;
    $btnSetJson.disabled = !enabled;
    $btnGetJson.disabled = !enabled;
    $btnRemove.disabled = !enabled;
    $btnSetPrefixed.disabled = !enabled;
    $btnGetPrefixed.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

// ── App state ────────────────────────────────────────────────────────
const SS58_PREFIX = 0; // Paseo — addresses start with "1"
const APP_NAME = "storage-demo";

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: APP_NAME });

let store: KvStore | null = null;
let prefixedStore: KvStore | null = null;

// ── UI subscriptions ─────────────────────────────────────────────────
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// ── Actions ──────────────────────────────────────────────────────────
$btnSet.addEventListener("click", async () => {
    if (!store) return;
    const key = $kvKeyInput.value;
    const value = $kvValueInput.value;
    setControlsEnabled(false);
    log(`Setting "${key}" = "${value}"…`);

    try {
        await store.set(key, value);
        log(`Set "${key}" = "${value}"`, "ok");
    } catch (err) {
        log(`Set failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnGet.addEventListener("click", async () => {
    if (!store) return;
    const key = $kvKeyInput.value;
    setControlsEnabled(false);
    log(`Getting "${key}"…`);

    try {
        const value = await store.get(key);
        const display = value === null ? "null" : value;
        $lastGetValue.textContent = display;
        log(`Get "${key}" → ${display}`, "ok");
    } catch (err) {
        log(`Get failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnSetJson.addEventListener("click", async () => {
    if (!store) return;
    const key = $kvKeyInput.value;
    const value = $kvValueInput.value;
    const obj = { text: value, n: 42 };
    setControlsEnabled(false);
    log(`Setting JSON "${key}" = ${JSON.stringify(obj)}…`);

    try {
        await store.setJSON(key, obj);
        log(`Set JSON "${key}" = ${JSON.stringify(obj)}`, "ok");
    } catch (err) {
        log(`Set JSON failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnGetJson.addEventListener("click", async () => {
    if (!store) return;
    const key = $kvKeyInput.value;
    setControlsEnabled(false);
    log(`Getting JSON "${key}"…`);

    try {
        const value = await store.getJSON(key);
        const display = value === null ? "null" : JSON.stringify(value);
        $lastGetValue.textContent = display;
        log(`Get JSON "${key}" → ${display}`, "ok");
    } catch (err) {
        log(`Get JSON failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnRemove.addEventListener("click", async () => {
    if (!store) return;
    const key = $kvKeyInput.value;
    setControlsEnabled(false);
    log(`Removing "${key}"…`);

    try {
        await store.remove(key);
        log(`Removed "${key}"`, "ok");
    } catch (err) {
        log(`Remove failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnSetPrefixed.addEventListener("click", async () => {
    if (!prefixedStore) return;
    const key = $kvKeyInput.value;
    const value = $kvValueInput.value;
    setControlsEnabled(false);
    log(`Setting prefixed "demo:${key}" = "${value}"…`);

    try {
        await prefixedStore.set(key, value);
        log(`Set prefixed "demo:${key}" = "${value}"`, "ok");
    } catch (err) {
        log(`Set prefixed failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnGetPrefixed.addEventListener("click", async () => {
    if (!prefixedStore) return;
    const key = $kvKeyInput.value;
    setControlsEnabled(false);
    log(`Getting prefixed "demo:${key}"…`);

    try {
        const value = await prefixedStore.get(key);
        const display = value === null ? "null" : value;
        $prefixedGetValue.textContent = display;
        log(`Get prefixed "demo:${key}" → ${display}`, "ok");
    } catch (err) {
        log(`Get prefixed failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function init() {
    log("Booting storage-demo…");

    // Step 1: connect signer (HostProvider inside the test host)
    log("Connecting signer…");
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

    // Step 2: detect backend type
    const inContainer = await isInsideContainer();
    const backend = inContainer ? "host" : "localStorage";
    $backendType.textContent = backend;
    log(`Backend detected: ${backend}`, "info");

    // Step 3: create KvStore (auto-detects host backend inside container)
    log("Creating KvStore…");
    try {
        store = await createKvStore();
        log(`KvStore created (${backend} backend)`, "ok");
    } catch (err) {
        $storeStatus.textContent = "error";
        log(`KvStore creation failed: ${(err as Error).message}`, "err");
        return;
    }

    // Step 4: create prefixed KvStore (prefix: "demo")
    log("Creating prefixed KvStore (prefix: demo)…");
    try {
        prefixedStore = await createKvStore({ prefix: "demo" });
        log(`Prefixed KvStore created (${backend} backend, prefix: demo)`, "ok");
    } catch (err) {
        $storeStatus.textContent = "error";
        log(`Prefixed KvStore creation failed: ${(err as Error).message}`, "err");
        return;
    }

    // Ready — enable controls
    $storeStatus.textContent = "ready";
    setControlsEnabled(true);
    log("Ready", "ok");
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
