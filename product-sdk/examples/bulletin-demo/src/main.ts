/**
 * Entry point for the @parity/product-sdk-bulletin E2E demo.
 *
 * Wires up SignerManager (account discovery) + BulletinClient (BYOD chain
 * client for the bulletin chain) and exposes upload/query operations to
 * Playwright via data-testid selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() → HostProvider → Bob's account
 *   2. createChainClient() → bulletin chain via direct WS (fallback)
 *   3. resolveUploadStrategy() → "preimage" (preimageManager.submit)
 *   4. resolveQueryStrategy() → "host-lookup" (preimageManager.lookup)
 *   5. upload() → preimage path → host stores data
 *   6. fetchBytes() → host-lookup path → host returns data
 */

import { SignerManager } from "@parity/product-sdk-signer";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { bulletin } from "@parity/product-sdk-descriptors/bulletin";
import {
    BulletinClient,
    getGateway,
    resolveUploadStrategy,
    resolveQueryStrategy,
    computeCid,
    cidToPreimageKey,
} from "@parity/product-sdk-bulletin";

import { appendLog, getEl } from "./ui.js";

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $bulletinStatus = getEl<HTMLSpanElement>("bulletin-status");
const $uploadStrategy = getEl<HTMLSpanElement>("upload-strategy");
const $queryStrategy = getEl<HTMLSpanElement>("query-strategy");
const $uploadInput = getEl<HTMLInputElement>("upload-input");
const $btnUpload = getEl<HTMLButtonElement>("btn-upload");
const $queryCidInput = getEl<HTMLInputElement>("query-cid-input");
const $btnQuery = getEl<HTMLButtonElement>("btn-query");
const $lastCid = getEl<HTMLSpanElement>("last-cid");
const $lastPreimageKey = getEl<HTMLSpanElement>("last-preimage-key");
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
        const result = await bulletinClient.upload(data);
        $lastCid.textContent = result.cid;
        $queryCidInput.value = result.cid;

        if (result.kind === "preimage") {
            $lastPreimageKey.textContent = result.preimageKey;
            log(`Uploaded (preimage): CID=${result.cid.slice(0, 20)}… key=${result.preimageKey.slice(0, 18)}…`, "ok");
        } else {
            $lastPreimageKey.textContent = "-";
            log(`Uploaded (transaction): CID=${result.cid.slice(0, 20)}… block=${result.blockHash.slice(0, 18)}…`, "ok");
        }
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

    // Step 2: resolve strategies (host detection happens here)
    log("Resolving upload strategy…");
    const uploadStrategy = await resolveUploadStrategy();
    $uploadStrategy.textContent = uploadStrategy.kind;
    log(`Upload strategy: ${uploadStrategy.kind}`, "ok");

    log("Resolving query strategy…");
    const queryStrategy = await resolveQueryStrategy();
    $queryStrategy.textContent = queryStrategy.kind;
    log(`Query strategy: ${queryStrategy.kind}`, "ok");

    // Step 3: create BYOD chain client with only bulletin chain
    log("Connecting to bulletin chain…");
    try {
        const chain = await createChainClient({
            chains: { bulletin },
            rpcs: {
                bulletin: ["wss://paseo-bulletin-rpc.polkadot.io"],
            },
        });
        bulletinClient = BulletinClient.from(chain.bulletin, getGateway("paseo"));
        $bulletinStatus.textContent = "connected";
        log("BulletinClient ready (BYOD)", "ok");
    } catch (err) {
        $bulletinStatus.textContent = "error";
        log(`Bulletin chain connect failed: ${(err as Error).message}`, "err");
        return;
    }

    // Expose utilities for e2e tests
    (window as unknown as Record<string, unknown>).__BULLETIN__ = {
        computeCid,
        cidToPreimageKey,
        client: bulletinClient,
    };

    // Ready — enable controls
    setControlsEnabled(true);
    log("Ready", "ok");
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
