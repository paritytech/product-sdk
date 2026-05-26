// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point for the @parity/product-sdk-keys E2E demo.
 *
 * Wires up SignerManager (for account discovery) + host-backed LocalKvStore +
 * SessionKeyManager, exposing a minimal UI that the Playwright suite drives
 * via data-testid selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() auto-detects -> HostProvider (product-sdk)
 *   2. Host responds with Bob's non-product account
 *   3. isInsideContainer() -> true (product-sdk sandbox detection)
 *   4. createLocalKvStore() -> host-backed LocalKvStore
 *   5. SessionKeyManager created with host-backed store
 *   6. Buttons drive create / get / clear / derive operations
 */

import { isInsideContainer } from "@parity/product-sdk-host";
import { SessionKeyManager } from "@parity/product-sdk-keys";
import { SignerManager } from "@parity/product-sdk-signer";
import { createLocalKvStore } from "@parity/product-sdk-local-storage";

import { appendLog, getEl } from "./ui.js";

// -- DOM ------------------------------------------------------------------
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $storageBackend = getEl<HTMLSpanElement>("storage-backend");
const $sessionStatus = getEl<HTMLSpanElement>("session-status");
const $btnCreate = getEl<HTMLButtonElement>("btn-create");
const $btnGet = getEl<HTMLButtonElement>("btn-get");
const $btnClear = getEl<HTMLButtonElement>("btn-clear");
const $btnDerive = getEl<HTMLButtonElement>("btn-derive");
const $mnemonicInput = getEl<HTMLInputElement>("mnemonic-input");
const $lastMnemonic = getEl<HTMLElement>("last-mnemonic");
const $lastSs58 = getEl<HTMLElement>("last-ss58");
const $lastH160 = getEl<HTMLElement>("last-h160");
const $log = getEl<HTMLElement>("keys-log");

function setControlsEnabled(enabled: boolean): void {
    $btnCreate.disabled = !enabled;
    $btnGet.disabled = !enabled;
    $btnClear.disabled = !enabled;
    $btnDerive.disabled = !enabled;
    $mnemonicInput.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

function displayKeyInfo(mnemonic: string, ss58: string, h160: string): void {
    $lastMnemonic.textContent = mnemonic;
    $lastSs58.textContent = ss58;
    $lastH160.textContent = h160;
}

function clearKeyInfo(): void {
    displayKeyInfo("-", "-", "-");
}

// -- App state ------------------------------------------------------------
const SS58_PREFIX = 0; // Paseo — addresses start with "1"
const APP_NAME = "keys-demo";

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: APP_NAME });
let sessionKeyManager: SessionKeyManager | null = null;

// -- UI subscriptions -----------------------------------------------------
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// -- Actions --------------------------------------------------------------
$btnCreate.addEventListener("click", async () => {
    if (!sessionKeyManager) return;
    setControlsEnabled(false);
    log("Creating new session key...");

    try {
        const info = await sessionKeyManager.create();
        displayKeyInfo(info.mnemonic, info.account.ss58Address, info.account.h160Address);
        log(`create() success — ${info.account.ss58Address}`, "ok");
    } catch (err) {
        log(`create() failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnGet.addEventListener("click", async () => {
    if (!sessionKeyManager) return;
    setControlsEnabled(false);
    log("Getting session key (getOrCreate)...");

    try {
        const existing = await sessionKeyManager.get();
        const info = await sessionKeyManager.getOrCreate();
        const action = existing ? "loaded" : "created";
        displayKeyInfo(info.mnemonic, info.account.ss58Address, info.account.h160Address);
        log(`getOrCreate() ${action} — ${info.account.ss58Address}`, "ok");
    } catch (err) {
        log(`getOrCreate() failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnClear.addEventListener("click", async () => {
    if (!sessionKeyManager) return;
    setControlsEnabled(false);
    log("Clearing session key...");

    try {
        await sessionKeyManager.clear();
        clearKeyInfo();
        log("clear() success", "ok");
    } catch (err) {
        log(`clear() failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnDerive.addEventListener("click", () => {
    if (!sessionKeyManager) return;
    const mnemonic = $mnemonicInput.value.trim();
    if (!mnemonic) {
        log("No mnemonic entered", "err");
        return;
    }

    log(`Deriving from mnemonic: "${mnemonic.slice(0, 20)}..."...`);

    try {
        const info = sessionKeyManager.fromMnemonic(mnemonic);
        displayKeyInfo(info.mnemonic, info.account.ss58Address, info.account.h160Address);
        log(`fromMnemonic() success — ${info.account.ss58Address}`, "ok");
    } catch (err) {
        displayKeyInfo("-", "error", "error");
        log(`fromMnemonic() failed: ${(err as Error).message}`, "err");
    }
});

// -- Boot -----------------------------------------------------------------
async function init() {
    log("Booting keys-demo...");

    // Step 1: connect signer (HostProvider inside the test host)
    log("Connecting signer...");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        log(`Signer connect failed: ${connectRes.error.message}`, "err");
        $sessionStatus.textContent = "error";
        return;
    }
    const accounts = connectRes.value;
    if (accounts.length === 0) {
        log("No accounts exposed by the host", "err");
        $sessionStatus.textContent = "error";
        return;
    }
    const selectRes = manager.selectAccount(accounts[0].address);
    if (!selectRes.ok) {
        log(`selectAccount failed: ${selectRes.error.message}`, "err");
        $sessionStatus.textContent = "error";
        return;
    }
    const address = accounts[0].address;
    log(`Signer ready: ${address}`, "ok");

    // Step 2: detect container environment
    log("Detecting container...");
    const inContainer = await isInsideContainer();
    $storageBackend.textContent = inContainer ? "host" : "localStorage";
    log(`isInsideContainer() = ${inContainer}`, inContainer ? "ok" : "info");

    // Step 3: create LocalKvStore (auto-detects host backend inside containers)
    log("Creating LocalKvStore...");
    const store = await createLocalKvStore();
    log(`LocalKvStore created (backend: ${inContainer ? "host" : "localStorage"})`, "ok");

    // Step 4: create SessionKeyManager
    sessionKeyManager = new SessionKeyManager({ store });
    log("SessionKeyManager created", "ok");

    // Step 5: mark session as ready and enable controls
    $sessionStatus.textContent = "ready";
    setControlsEnabled(true);
    log("Ready", "ok");
}

init().catch((err) => {
    log(`Unhandled init error: ${(err as Error).message}`, "err");
    $sessionStatus.textContent = "error";
});
