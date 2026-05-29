// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point for the @parity/product-sdk-tx E2E demo.
 *
 * Wires up SignerManager + chain-client + submitAndWatch/batchSubmitAndWatch,
 * exposing a minimal UI that the Playwright suite drives via data-testid
 * selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() establishes the HostProvider session.
 *   2. manager.getProductAccount("tx-demo.dot", 0) asks the host for a
 *      DotNS-derived product account. The fixture maps "tx-demo.dot/0" to
 *      Bob's funded keypair via `productAccounts`.
 *   3. getChainAPI("paseo") routes RPC through the host's chainConnection.
 *   4. submitAndWatch uses productAccount.getSigner() — which routes
 *      through `getProductAccountSigner(..., "createTransaction")` and
 *      preserves arbitrary signed extensions (e.g. AsPgas on Paseo Next).
 *
 * Why not the legacy-account path: `manager.connect()` + `selectAccount`
 * + `manager.getSigner()` builds the signer via `getLegacyAccountSigner`,
 * which has no signerType switch upstream and always routes through PJS.
 * PJS throws on unknown signed extensions like AsPgas. Product-account
 * signing avoids that path entirely.
 */

import type { SignerAccount } from "@parity/product-sdk-signer";
import { SignerManager } from "@parity/product-sdk-signer";
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { submitAndWatch, batchSubmitAndWatch } from "@parity/product-sdk-tx";
import type { TxStatus } from "@parity/product-sdk-tx";
import { Binary } from "polkadot-api";

import { appendLog, getEl } from "./ui.js";

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $remarkInput = getEl<HTMLInputElement>("remark-input");
const $btnSubmitRemark = getEl<HTMLButtonElement>("btn-submit-remark");
const $btnSubmitBatch = getEl<HTMLButtonElement>("btn-submit-batch");
const $remarkFinalizedInput = getEl<HTMLInputElement>("remark-finalized-input");
const $btnSubmitRemarkFinalized = getEl<HTMLButtonElement>("btn-submit-remark-finalized");
const $btnSubmitBadTx = getEl<HTMLButtonElement>("btn-submit-bad-tx");
const $txLog = getEl<HTMLElement>("tx-log");

function setControlsEnabled(enabled: boolean): void {
    $remarkInput.disabled = !enabled;
    $btnSubmitRemark.disabled = !enabled;
    $btnSubmitBatch.disabled = !enabled;
    $remarkFinalizedInput.disabled = !enabled;
    $btnSubmitRemarkFinalized.disabled = !enabled;
    $btnSubmitBadTx.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($txLog, msg, level);
}

// ── App state ────────────────────────────────────────────────────────
// Paseo Asset Hub uses SS58 prefix 0 — addresses start with "1".
// Matches host-api-test-sdk's PASEO_ASSET_HUB.
const SS58_PREFIX = 0;

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: "tx-demo" });

// The product account we sign all transactions with. Populated by init()
// via `manager.getProductAccount("tx-demo.dot", 0)`. Its `getSigner()`
// routes through the host's `host_create_transaction` path so unknown
// signed extensions (e.g. AsPgas on Paseo Next) round-trip end-to-end.
let productAccount: SignerAccount | null = null;

type ChainClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
let chain: ChainClient | null = null;

// ── UI subscriptions ─────────────────────────────────────────────────
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = productAccount?.address ?? "-";
    const ready = state.status === "connected" && productAccount !== null && chain !== null;
    setControlsEnabled(ready);
});

function renderProductAccountReady(): void {
    $accountAddress.textContent = productAccount?.address ?? "-";
    const state = manager.getState();
    const ready = state.status === "connected" && productAccount !== null && chain !== null;
    setControlsEnabled(ready);
}

// ── Transaction logger: surface status transitions to the UI ─────────
function makeStatusLogger(label: string) {
    return (status: TxStatus) => {
        if (status === "in-block") {
            log(`${label}: in best block`, "ok");
        } else if (status === "finalized") {
            log(`${label}: finalized`, "finalized");
        } else if (status === "error") {
            log(`${label}: error`, "err");
        } else {
            log(`${label}: ${status}`);
        }
    };
}

// ── Actions ──────────────────────────────────────────────────────────
$btnSubmitRemark.addEventListener("click", async () => {
    if (!chain) {
        log("Chain client not ready", "err");
        return;
    }
    if (!productAccount) {
        log("Product account not ready", "err");
        return;
    }
    const signer = productAccount.getSigner();
    const text = $remarkInput.value || "tx-demo remark";
    setControlsEnabled(false);
    log(`Submitting System.remark("${text}")…`);

    try {
        const tx = chain.assetHub.tx.System.remark({ remark: Binary.fromText(text) });
        const result = await submitAndWatch(tx, signer, {
            // Default is "best-block"; keep the subscription alive so the
            // finalized event still surfaces in the log once the relay chain
            // catches up, but release the button as soon as the tx lands.
            onStatus: makeStatusLogger("remark"),
        });
        if (result.ok) {
            log(`remark landed in block #${result.block.number} (${result.txHash.slice(0, 18)}…)`, "ok");
        } else {
            log(`remark failed: ${JSON.stringify(result.dispatchError)}`, "err");
        }
    } catch (err) {
        log(`remark failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnSubmitBatch.addEventListener("click", async () => {
    if (!chain) {
        log("Chain client not ready", "err");
        return;
    }
    if (!productAccount) {
        log("Product account not ready", "err");
        return;
    }
    const signer = productAccount.getSigner();
    setControlsEnabled(false);
    log("Submitting Utility.batch_all with 3 System.remark calls…");

    try {
        const calls = [1, 2, 3].map((i) =>
            chain!.assetHub.tx.System.remark({ remark: Binary.fromText(`batch-${i}`) }),
        );
        const result = await batchSubmitAndWatch(calls, chain.assetHub, signer, {
            mode: "batch_all",
            onStatus: makeStatusLogger("batch"),
        });
        if (result.ok) {
            log(`batch landed in block #${result.block.number} (${result.txHash.slice(0, 18)}…)`, "ok");
        } else {
            log(`batch failed: ${JSON.stringify(result.dispatchError)}`, "err");
        }
    } catch (err) {
        log(`batch failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// Same as remark, but waits for relay-chain finality before resolving.
// Covers the `waitFor: "finalized"` branch in submitAndWatch.
$btnSubmitRemarkFinalized.addEventListener("click", async () => {
    if (!chain) {
        log("Chain client not ready", "err");
        return;
    }
    if (!productAccount) {
        log("Product account not ready", "err");
        return;
    }
    const signer = productAccount.getSigner();
    const text = $remarkFinalizedInput.value || "tx-demo finalized remark";
    setControlsEnabled(false);
    log(`Submitting System.remark("${text}") — waitFor=finalized…`);

    try {
        const tx = chain.assetHub.tx.System.remark({ remark: Binary.fromText(text) });
        const result = await submitAndWatch(tx, signer, {
            waitFor: "finalized",
            onStatus: makeStatusLogger("remark-finalized"),
        });
        if (result.ok) {
            log(
                `remark-finalized finalized in block #${result.block.number} (${result.txHash.slice(0, 18)}…)`,
                "finalized",
            );
        } else {
            log(`remark-finalized failed: ${JSON.stringify(result.dispatchError)}`, "err");
        }
    } catch (err) {
        log(`remark-finalized failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// Balances.force_set_balance is root-only. Signed correctly, the extrinsic
// lands in a block and then fails at dispatch with BadOrigin — exercising
// the TxDispatchError branch of submitAndWatch.
$btnSubmitBadTx.addEventListener("click", async () => {
    if (!chain) {
        log("Chain client not ready", "err");
        return;
    }
    if (!productAccount) {
        log("Product account not ready", "err");
        return;
    }
    const signer = productAccount.getSigner();
    setControlsEnabled(false);
    log("Submitting Balances.force_set_balance (root-only)…");

    try {
        const tx = chain.assetHub.tx.Balances.force_set_balance({
            who: { type: "Id", value: productAccount.address },
            new_free: 1n,
        });
        const result = await submitAndWatch(tx, signer, {
            onStatus: makeStatusLogger("bad-tx"),
        });
        if (result.ok) {
            log(`bad-tx unexpectedly succeeded in block #${result.block.number}`, "err");
        } else {
            log(`bad-tx dispatch error: ${JSON.stringify(result.dispatchError)}`, "err");
        }
    } catch (err) {
        // TxDispatchError rejects the promise — this is the expected path.
        const e = err as Error;
        log(`bad-tx rejected: ${e.name}: ${e.message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function init() {
    log("Booting tx-demo…");

    // Step 1: establish the host session. We don't use the returned legacy
    // accounts — they sign via the PJS bridge, which throws on unknown
    // signed extensions (e.g. AsPgas on Paseo Next). The product-account
    // request below uses `getProductAccountSigner` with `"createTransaction"`
    // and avoids that path.
    log("Connecting signer…");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        log(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }

    // Step 2: request the product account. The fixture maps
    // "tx-demo.dot/0" → bob via `productAccounts`, so this returns Bob's
    // funded account but signs through host_create_transaction.
    log("Requesting product account tx-demo.dot/0…");
    const productRes = await manager.getProductAccount("tx-demo.dot", 0);
    if (!productRes.ok) {
        log(`getProductAccount failed: ${productRes.error.message}`, "err");
        return;
    }
    productAccount = productRes.value;
    log(`Product account ready: ${productAccount.address}`, "ok");

    // Step 3: open chain client. Inside the test host this routes through
    // the host's chainConnection handler; outside it falls back to public RPC.
    log("Opening chain client (getChainAPI('paseo'))…");
    try {
        chain = await getChainAPI("paseo");
        log("Chain client ready (assetHub, bulletin, individuality)", "ok");
    } catch (err) {
        log(`Chain client failed: ${(err as Error).message}`, "err");
        return;
    }

    // Re-emit state so the controls enable now that `chain` is non-null.
    renderProductAccountReady();
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
