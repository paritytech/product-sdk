/**
 * Entry point for the @parity/product-sdk-contracts E2E demo.
 *
 * Wires up SignerManager + chain-client + ContractManager against the
 * t3rminal @t3rminal/bulletin-index contract deployed on Paseo Asset Hub.
 *
 * Contract address: 0xA2E388421467E0193570Af45Bd03F0F379c47E88
 *
 * Exercises the two core host-API paths in @parity/product-sdk-contracts:
 *   - query()  — dry-run via chain RPC (no signing)
 *   - tx()     — signed extrinsic via host's handleSignPayload
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() auto-detects → HostProvider
 *   2. Host responds with Bob's non-product account
 *   3. getChainAPI("paseo") routes RPC through the host's chainConnection handler
 *   4. ContractManager.fromClient(cdm, chain.raw.assetHub) wraps the contract
 *   5. contract.owner.query() → dry-run via RPC — no signing
 *   6. contract.storeDailyReport.tx() → signs via host.handleSignPayload → on-chain
 */

import { SignerManager } from "@parity/product-sdk-signer";
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { ContractManager } from "@parity/product-sdk-contracts";

import cdm from "./cdm.json";
import { appendLog, getEl } from "./ui.js";

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $reportDateInput = getEl<HTMLInputElement>("report-date-input");
const $reportCidInput = getEl<HTMLInputElement>("report-cid-input");
const $btnQueryOwner = getEl<HTMLButtonElement>("btn-query-owner");
const $btnStoreReport = getEl<HTMLButtonElement>("btn-store-report");
const $contractLog = getEl<HTMLElement>("contract-log");

function setControlsEnabled(enabled: boolean): void {
    $btnQueryOwner.disabled = !enabled;
    $btnStoreReport.disabled = !enabled;
    $reportDateInput.disabled = !enabled;
    $reportCidInput.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($contractLog, msg, level);
}

// ── App state ────────────────────────────────────────────────────────
const SS58_PREFIX = 0; // Paseo Asset Hub

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: "contracts-demo" });

type ChainClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
let chain: ChainClient | null = null;
let contractManager: ContractManager | null = null;

// ── UI subscriptions ─────────────────────────────────────────────────
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
    const ready =
        state.status === "connected" && state.selectedAccount !== null && contractManager !== null;
    setControlsEnabled(ready);
});

// ── Actions ──────────────────────────────────────────────────────────

/**
 * Read-only query — calls owner() as a chain-RPC dry-run.
 * No signing is involved; proves the query() path works through the host.
 */
$btnQueryOwner.addEventListener("click", async () => {
    if (!contractManager) {
        log("Contract manager not ready", "err");
        return;
    }
    log("Querying bulletin-index owner()…");
    try {
        const contract = contractManager.getContract("@t3rminal/bulletin-index");
        const result = await contract.owner.query();
        if (result.success) {
            log(`owner: ${result.value}`, "ok");
        } else {
            log("owner() query failed (dry-run returned success=false)", "err");
        }
    } catch (err) {
        log(`query failed: ${(err as Error).message}`, "err");
    }
});

/**
 * Signed transaction — calls storeDailyReport(date, cid, count).
 * The contract is permissionless: any address can store a daily report
 * indexed by msg.sender. Exercises the full host-signing path.
 */
$btnStoreReport.addEventListener("click", async () => {
    if (!contractManager) {
        log("Contract manager not ready", "err");
        return;
    }
    const signer = manager.getSigner();
    if (!signer) {
        log("No signer selected", "err");
        return;
    }

    const date = $reportDateInput.value || "2026-01-01";
    const cid = $reportCidInput.value || "bafktest";

    setControlsEnabled(false);
    log(`Submitting storeDailyReport("${date}", "${cid}", 1)…`);

    try {
        const contract = contractManager.getContract("@t3rminal/bulletin-index");
        const result = await contract.storeDailyReport.tx(date, cid, 1n, { signer });
        if (result.ok) {
            log(
                `storeDailyReport landed in block #${result.block.number} (${result.txHash.slice(0, 18)}…)`,
                "ok",
            );
        } else {
            log(`storeDailyReport dispatch error: ${JSON.stringify(result.dispatchError)}`, "err");
        }
    } catch (err) {
        log(`storeDailyReport failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function init() {
    log("Booting contracts-demo…");

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

    log("Opening chain client…");
    try {
        chain = await getChainAPI("paseo");
        log("Chain client ready", "ok");
    } catch (err) {
        log(`Chain client failed: ${(err as Error).message}`, "err");
        return;
    }

    log("Initialising ContractManager…");
    try {
        contractManager = await ContractManager.fromClient(cdm as any, chain.raw.assetHub, {
            signerManager: manager,
        });
        log("ContractManager ready (@t3rminal/bulletin-index)", "ok");
    } catch (err) {
        log(`ContractManager failed: ${(err as Error).message}`, "err");
        return;
    }

    setControlsEnabled(manager.getState().selectedAccount !== null);
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
