/**
 * Entry point for the @parity/product-sdk-bulletin demo.
 *
 * Wires up SignerManager (account discovery) + BulletinClient (against the
 * bulletin chain via @parity/bulletin-sdk's AsyncBulletinClient).
 *
 * Flow:
 *   1. SignerManager.connect() → HostProvider → account
 *   2. BulletinClient.create() with a lazy signer
 *   3. .store(data).send() → signed TransactionStorage.store extrinsic
 *   4. .fetchBytes(cid) → host preimage subscription (container-only)
 */

import { SignerManager } from "@parity/product-sdk-signer";
import {
    BulletinClient,
    calculateCid,
    cidToPreimageKey,
    createLazySigner,
} from "@parity/product-sdk-bulletin";

import { appendLog, getEl } from "./ui.js";

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $bulletinStatus = getEl<HTMLSpanElement>("bulletin-status");
const $uploadInput = getEl<HTMLInputElement>("upload-input");
const $btnUpload = getEl<HTMLButtonElement>("btn-upload");
const $queryCidInput = getEl<HTMLInputElement>("query-cid-input");
const $btnQuery = getEl<HTMLButtonElement>("btn-query");
const $lastCid = getEl<HTMLSpanElement>("last-cid");
const $lastBlockHash = getEl<HTMLSpanElement>("last-block");
const $queryResult = getEl<HTMLSpanElement>("query-result");
const $log = getEl<HTMLElement>("bulletin-log");

function setControlsEnabled(enabled: boolean): void {
    $uploadInput.disabled = !enabled;
    $btnUpload.disabled = !enabled;
    $queryCidInput.disabled = !enabled;
    $btnQuery.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

// ── App state ────────────────────────────────────────────────────────
const SS58_PREFIX = 0;
const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: "bulletin-demo" });
let bulletinClient: BulletinClient | null = null;

// ── UI subscriptions ─────────────────────────────────────────────────
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// ── Actions ──────────────────────────────────────────────────────────
$btnUpload.addEventListener("click", async () => {
    if (!bulletinClient) {
        log("BulletinClient not ready", "err");
        return;
    }
    const text = $uploadInput.value || "hello";
    const data = new TextEncoder().encode(text);
    setControlsEnabled(false);
    log(`Uploading: "${text}" (${data.length} bytes)…`);

    try {
        const result = await bulletinClient.store(data).send();
        const cid = result.cid?.toString() ?? "(no manifest CID)";
        $lastCid.textContent = cid;
        $queryCidInput.value = cid;

        const blockNumber = result.blockNumber !== undefined ? `#${result.blockNumber}` : "-";
        $lastBlockHash.textContent = blockNumber;
        log(
            `Uploaded: CID=${cid.slice(0, 20)}… block=${blockNumber} size=${result.size} bytes`,
            "ok",
        );
    } catch (err) {
        log(`Upload failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnQuery.addEventListener("click", async () => {
    if (!bulletinClient) {
        log("BulletinClient not ready", "err");
        return;
    }
    const cid = $queryCidInput.value;
    if (!cid) {
        log("No CID to query — upload first", "err");
        return;
    }
    setControlsEnabled(false);
    log(`Querying: CID=${cid.slice(0, 20)}…`);

    try {
        const bytes = await bulletinClient.fetchBytes(cid);
        const text = new TextDecoder().decode(bytes);
        $queryResult.textContent = text;
        log(`Query result (${bytes.length} bytes): "${text}"`, "ok");
    } catch (err) {
        log(`Query failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function init() {
    log("Booting bulletin-demo…");

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
    log(`Signer ready: ${accounts[0].address}`, "ok");

    // Step 2: create BulletinClient with a lazy signer that resolves
    // through the SignerManager on every sign call.
    log("Creating BulletinClient…");
    try {
        bulletinClient = await BulletinClient.create({
            environment: "paseo",
            signer: createLazySigner(() => manager.getSigner()),
        });
        $bulletinStatus.textContent = "connected";
        log("BulletinClient ready", "ok");
    } catch (err) {
        $bulletinStatus.textContent = "error";
        log(`BulletinClient init failed: ${(err as Error).message}`, "err");
        return;
    }

    // Expose utilities for manual debugging in the browser console.
    (window as unknown as Record<string, unknown>).__BULLETIN__ = {
        calculateCid,
        cidToPreimageKey,
        client: bulletinClient,
    };

    // Ready — enable controls
    setControlsEnabled(true);
    log("Ready", "ok");
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
