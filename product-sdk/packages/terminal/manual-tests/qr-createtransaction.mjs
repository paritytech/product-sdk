// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Manual end-to-end test for the **createTransaction** signing path.
 *
 * Pairs (or reuses) a Polkadot-mobile session, then signs a real extrinsic via
 * `signer.signTx` — which routes through `session.createTransaction`. This is
 * what `qr-pair-and-sign.mjs` does NOT cover (that one only exercises
 * `signBytes`). Approving on the phone here proves the wallet builds + signs a
 * full extrinsic, with every signed extension (incl. AsPgas) preserved.
 *
 * It uses `tx.sign(signer)` (sign only — no broadcast), so the product account
 * does NOT need to be funded; nothing is submitted to the chain.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO RUN  (from packages/terminal, after `pnpm --filter @parity/product-sdk-terminal build`)
 *
 *   # Fresh pair (renders a QR to scan):
 *   node manual-tests/qr-createtransaction.mjs
 *
 *   # Reuse a session paired by an earlier run (skips the QR):
 *   STORAGE_DIR=/tmp/terminal-ct-XXXX node manual-tests/qr-createtransaction.mjs
 *
 *   # Point at the chain your mobile app supports (default: Paseo Asset Hub Next):
 *   CHAIN_WS=wss://paseo-asset-hub-next-rpc.polkadot.io node manual-tests/qr-createtransaction.mjs
 *
 * The chain you connect to sets the `genesisHash` sent to the wallet, so the
 * mobile app must recognise it. If signing hangs/rejects, first confirm the app
 * supports that chain's `host_create_transaction` flow.
 *
 * NOTE on the signer's public key: this uses `createSessionSigner(session,
 * adapter)`, which (absent a host-supplied product key) falls back to the
 * session's selected account. That is only correct when the product account IS
 * the selected account. If your host derives a distinct product-account key,
 * pass it: `createSessionSigner(session, adapter, productPublicKey)`.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
    createSessionSigner,
    createTerminalAdapter,
    renderQrCode,
    SS_PASEO_STABLE_STAGE_ENDPOINTS,
    SS_STABLE_STAGE_ENDPOINTS,
    waitForSessions,
} from "@parity/product-sdk-terminal";
// Preview-stage statement store isn't re-exported by the terminal package; pull it from host-papp.
import { SS_PREVIEW_STAGE_ENDPOINTS } from "@novasamatech/host-papp";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { Binary, createClient } from "polkadot-api";

const APP_ID = "terminal-ct-manual-test";
// The mobile app FETCHES this URL during pairing and decodes it as
// { name: string, icon: <image URL> } — and then fetches the icon too. Both
// must be reachable or the phone shows "failed to load pairing request".
// The default placeholder will NOT pair — pass a real one via METADATA_URL.
const META_URL = process.env.METADATA_URL ?? "https://example.com/metadata.json";
const CHAIN_WS = process.env.CHAIN_WS ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const STEP_TIMEOUT_MS = 120_000;

// The statement-store "people" chain that relays the pairing handshake. The CLI
// and your phone MUST be on the same one or authenticate() will time out.
// Select with SS_STAGE=paseo|stable|preview, or pass raw URLs via SS_ENDPOINTS.
const SS_STAGES = {
    paseo: SS_PASEO_STABLE_STAGE_ENDPOINTS,
    stable: SS_STABLE_STAGE_ENDPOINTS,
    preview: SS_PREVIEW_STAGE_ENDPOINTS,
};
const ENDPOINTS = process.env.SS_ENDPOINTS
    ? process.env.SS_ENDPOINTS.split(",").map((s) => s.trim())
    : (SS_STAGES[process.env.SS_STAGE ?? "paseo"] ?? SS_PASEO_STABLE_STAGE_ENDPOINTS);

const storageDir = process.env.STORAGE_DIR ?? mkdtempSync(join(tmpdir(), "terminal-ct-"));
const isReplay = Boolean(process.env.STORAGE_DIR) && existsSync(storageDir);

const rl = createInterface({ input: stdin, output: stdout });
let exitCode = 0;

const log = (m) => console.log(m);
const ok = (m) => console.log(`    ✓ ${m}`);
const fail = (m, e) => {
    console.error(`    ✗ ${m}${e ? `: ${e.message ?? e}` : ""}`);
    exitCode = 1;
};

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}

log("═".repeat(63));
log("  @parity/product-sdk-terminal — createTransaction manual test");
log("═".repeat(63));
log(`  storageDir: ${storageDir}`);
log(`  chain:      ${CHAIN_WS}`);
log(`  ss-relay:   ${ENDPOINTS.join(", ")}`);
log(`  mode:       ${isReplay ? "REPLAY (load session)" : "FRESH (QR pair)"}`);
log(`  metadata:   ${META_URL}`);
log("═".repeat(63));
if (!isReplay && META_URL.includes("example.com")) {
    log(
        "\n  ⚠️  METADATA_URL is the placeholder (example.com) — the phone will\n" +
            '     show "failed to load pairing request". Pass a reachable URL that\n' +
            "     returns {\"name\":\"…\",\"icon\":\"<reachable image url>\"}:\n" +
            "       METADATA_URL=https://… node manual-tests/qr-createtransaction.mjs\n",
    );
}

let adapter;
let client;
try {
    adapter = createTerminalAdapter({
        appId: APP_ID,
        metadataUrl: META_URL,
        endpoints: ENDPOINTS,
        storageDir,
    });

    // ── Obtain a session (load or pair) ───────────────────────────────────
    let session;
    if (isReplay) {
        log("\n[1] Loading persisted session…");
        const sessions = await waitForSessions(adapter, 10_000);
        if (sessions.length === 0) throw new Error("no persisted session in STORAGE_DIR");
        session = sessions[0];
        ok(`loaded session ${session.id}`);
    } else {
        log("\n[1] Pairing — scan the QR with your Polkadot mobile app, then approve");
        const qrShown = { v: false };
        const qrPromise = new Promise((resolve, reject) => {
            const unsub = adapter.sso.pairingStatus.subscribe(async (status) => {
                if (status.step === "pairing" && !qrShown.v) {
                    qrShown.v = true;
                    try {
                        log("\n" + (await renderQrCode(status.payload)) + "\n");
                        unsub();
                        resolve();
                    } catch (e) {
                        unsub();
                        reject(e);
                    }
                }
            });
        });
        const authPromise = adapter.sso.authenticate();
        await withTimeout(qrPromise, 30_000, "QR emission");
        const authResult = await withTimeout(authPromise, STEP_TIMEOUT_MS, "authenticate");
        if (authResult.isErr()) throw authResult.error;
        const sessions = await waitForSessions(adapter, 5_000);
        if (sessions.length === 0) throw new Error("no session after authenticate");
        session = sessions[0];
        ok(`paired — session ${session.id}`);
    }

    // ── Build the signer ──────────────────────────────────────────────────
    log("\n[2] Build signer");
    const signer = createSessionSigner(session, adapter);
    if (signer.publicKey?.length !== 32) throw new Error(`signer.publicKey wrong length: ${signer.publicKey?.length}`);
    ok(`signer.publicKey: 0x${Buffer.from(signer.publicKey).toString("hex")}`);

    // ── Sign a real extrinsic via createTransaction ───────────────────────
    log(`\n[3] Connect to chain + build System.remark`);
    client = createClient(getWsProvider(CHAIN_WS));
    const api = client.getUnsafeApi();
    const tx = api.tx.System.remark({
        remark: Binary.fromText("product-sdk-terminal createTransaction QR test"),
    });
    ok("extrinsic built (System.remark)");

    log("\n[4] Sign via createTransaction — APPROVE ON YOUR PHONE");
    log("    (this calls signer.signTx → session.createTransaction)");
    await rl.question("    > Press ENTER when ready, then approve on the device… ");
    try {
        const signed = await withTimeout(tx.sign(signer), STEP_TIMEOUT_MS, "tx.sign");
        if (typeof signed === "string" && signed.startsWith("0x") && signed.length > 2) {
            ok(`createTransaction returned a signed extrinsic (${(signed.length - 2) / 2} bytes)`);
            ok("✅ createTransaction signing path verified end-to-end");
        } else {
            fail(`unexpected sign() result: ${String(signed).slice(0, 40)}`);
        }
    } catch (e) {
        fail("createTransaction signing failed (phone declined, chain unsupported, or timeout)", e);
    }
} catch (e) {
    fail("UNCAUGHT", e);
} finally {
    rl.close();
    try {
        client?.destroy();
    } catch {
        /* ignore */
    }
    try {
        await adapter?.destroy();
    } catch {
        /* ignore */
    }
    log("\n" + "═".repeat(63));
    log(exitCode === 0 ? "  ✓ PASSED" : "  ✗ FAILED");
    if (!isReplay && exitCode === 0) {
        log(`\n  Reuse this session next time:\n    STORAGE_DIR=${storageDir} node manual-tests/qr-createtransaction.mjs`);
    }
    log("═".repeat(63));
    setTimeout(() => process.exit(exitCode), 200);
}
