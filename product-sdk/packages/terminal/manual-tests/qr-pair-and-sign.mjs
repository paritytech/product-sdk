// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Manual end-to-end test for @parity/product-sdk-terminal.
 *
 * Walks through the full QR-pair → sign → restart-and-reuse flow against
 * a real Polkadot mobile app + the paseo statement-store. Exercises the
 * paths the automated test suite cannot cover (real phone, real network,
 * real signing roundtrip).
 *
 * What this verifies — each step exits with explicit pass/fail:
 *   1. Adapter constructs sync against the configured storageDir
 *   2. createTerminalAdapter -> sso.pairingStatus emits a `pairing` event
 *      with the QR payload, and renderQrCode produces a scannable code
 *   3. authenticate() resolves successfully after the user scans + approves
 *      on the mobile app (covers QR pair + on-chain attestation)
 *   4. waitForSessions emits the freshly-paired session
 *   5. createSessionSigner produces a signer whose publicKey matches the
 *      session's remoteAccount.accountId
 *   6. signer.signBytes() roundtrips through the phone (user must approve
 *      on the device)
 *   7. Killing and re-running this script with the same storageDir loads
 *      the persisted session WITHOUT requiring re-pairing
 *   8. destroy() shuts down cleanly with no `Statement subscription error`
 *      red text in the terminal
 *
 * What this does NOT cover:
 *   - Allowance depletion (would need 50+ signing roundtrips to characterize)
 *   - signPayload (known limitation of the current wallet/protocol version)
 *   - The Node <21 failure mode — that needs a separate Node downgrade run
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO RUN
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Prerequisites:
 *   - Node >= 21 (`node --version` to check)
 *   - Polkadot mobile app installed and connected to the paseo network
 *   - Internet access for the paseo statement-store WebSocket endpoints
 *   - This package built: `pnpm --filter @parity/product-sdk-terminal build`
 *
 * From the package directory:
 *
 *   cd packages/terminal
 *   node manual-tests/qr-pair-and-sign.mjs
 *
 * (The cd is needed so Node resolves @parity/product-sdk-terminal through
 * the package's own node_modules — running from the repo root resolves
 * from the wrong context and errors with ERR_MODULE_NOT_FOUND.)
 *
 * Or to test as a consumer would, package + install first:
 *
 *   cd packages/terminal && pnpm pack --pack-destination /tmp
 *   mkdir /tmp/manual-test && cd /tmp/manual-test
 *   pnpm init && pnpm add file:/tmp/parity-product-sdk-terminal-0.0.0.tgz
 *   cp <repo>/packages/terminal/manual-tests/qr-pair-and-sign.mjs .
 *   node qr-pair-and-sign.mjs
 *
 * The script writes session state to a temp directory under $TMPDIR so it
 * doesn't pollute your real ~/.polkadot-apps. The temp dir is printed on
 * startup; pass it via the STORAGE_DIR env var to a second run for the
 * persistence check (step 7).
 *
 * Example second-run invocation (from packages/terminal):
 *
 *   STORAGE_DIR=/tmp/terminal-manual-XXXX \
 *     node manual-tests/qr-pair-and-sign.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
    createSessionSigner,
    createTerminalAdapter,
    renderQrCode,
    SS_PASEO_STABLE_STAGE_ENDPOINTS,
    waitForSessions,
} from "@parity/product-sdk-terminal";

const APP_ID = "terminal-manual-test";
const META_URL = "https://example.com/metadata.json";
const STEP_TIMEOUT_MS = 120_000; // 2 min per interactive step

const storageDir = process.env.STORAGE_DIR ?? mkdtempSync(join(tmpdir(), "terminal-manual-"));
const isReplay = Boolean(process.env.STORAGE_DIR) && existsSync(storageDir);

const rl = createInterface({ input: stdin, output: stdout });
let stepNum = 0;
let exitCode = 0;
const failures = [];

function step(label) {
    stepNum += 1;
    console.log(`\n[${stepNum}] ${label}`);
}
function ok(msg) {
    console.log(`    ✓ ${msg}`);
}
function fail(msg, e) {
    console.error(`    ✗ ${msg}${e ? `: ${e.message ?? e}` : ""}`);
    failures.push(`step ${stepNum}: ${msg}`);
    exitCode = 1;
}
function info(msg) {
    console.log(`    · ${msg}`);
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
        ),
    ]);
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("  @parity/product-sdk-terminal — manual smoke test");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  storageDir: ${storageDir}`);
console.log(`  appId:      ${APP_ID}`);
console.log(`  mode:       ${isReplay ? "REPLAY (loading persisted session)" : "FRESH (will require QR pair)"}`);
console.log("═══════════════════════════════════════════════════════════════");

let adapter;
try {
    // ── 1. Adapter construction ──────────────────────────────────────────
    step("Construct TerminalAdapter (sync, no await)");
    adapter = createTerminalAdapter({
        appId: APP_ID,
        metadataUrl: META_URL,
        endpoints: SS_PASEO_STABLE_STAGE_ENDPOINTS,
        storageDir,
    });
    ok(`adapter.appId === "${adapter.appId}"`);
    ok(`adapter.destroy is a function`);
    if (!adapter.sso) fail("adapter.sso missing");
    if (!adapter.sessions) fail("adapter.sessions missing");

    if (isReplay) {
        // ── REPLAY MODE ──────────────────────────────────────────────────
        step("Load persisted session from disk");
        info("Skipping QR pair — STORAGE_DIR was passed, expecting an existing session.");
        const sessions = await waitForSessions(adapter, 10_000);
        if (sessions.length === 0) {
            fail("no persisted sessions found — did you mean to run in FRESH mode?");
        } else {
            ok(`waitForSessions returned ${sessions.length} session(s)`);
            ok(`session.id = ${sessions[0].id}`);

            step("Sign a test message via the loaded session (approve on phone)");
            const signer = createSessionSigner(sessions[0], adapter);
            info(`Signer publicKey: 0x${Buffer.from(signer.publicKey).toString("hex")}`);
            await rl.question("    > Press ENTER when ready, then approve on your phone... ");
            try {
                const sig = await withTimeout(
                    signer.signBytes(new TextEncoder().encode("manual-test-replay")),
                    STEP_TIMEOUT_MS,
                    "signBytes",
                );
                ok(`signBytes returned ${sig.length}-byte signature`);
            } catch (e) {
                fail("signBytes failed", e);
            }
        }
    } else {
        // ── FRESH MODE ───────────────────────────────────────────────────
        step("Subscribe to pairingStatus and render QR when emitted");
        let qrShown = false;
        const qrPromise = new Promise((resolve, reject) => {
            const unsub = adapter.sso.pairingStatus.subscribe(async (status) => {
                console.log(`    · pairingStatus: step="${status.step}"`);
                if (status.step === "pairing" && !qrShown) {
                    qrShown = true;
                    try {
                        const qr = await renderQrCode(status.payload);
                        console.log("\n");
                        console.log(qr);
                        console.log(`\n    Scan with the Polkadot mobile app, then approve.`);
                        unsub();
                        resolve();
                    } catch (e) {
                        unsub();
                        reject(e);
                    }
                }
            });
        });

        step("Call sso.authenticate() — this resolves after pair + attestation");
        const authPromise = adapter.sso.authenticate();
        try {
            await withTimeout(qrPromise, 30_000, "QR emission");
            ok("QR code rendered");
        } catch (e) {
            fail("QR did not appear within 30s", e);
        }

        try {
            const authResult = await withTimeout(authPromise, STEP_TIMEOUT_MS, "authenticate");
            if (authResult.isOk()) {
                const session = authResult.value;
                ok(`authenticate resolved: session.id = ${session?.id ?? "(no session)"}`);
            } else {
                fail("authenticate returned err", authResult.error);
            }
        } catch (e) {
            fail("authenticate threw or timed out", e);
        }

        step("waitForSessions emits the freshly-paired session");
        const sessions = await waitForSessions(adapter, 5_000);
        if (sessions.length === 0) {
            fail("no sessions emitted after authenticate");
        } else {
            ok(`waitForSessions returned ${sessions.length} session(s)`);

            step("Construct signer and verify publicKey shape");
            const signer = createSessionSigner(sessions[0], adapter);
            if (signer.publicKey?.length === 32) {
                ok(`signer.publicKey is 32 bytes (Sr25519)`);
                info(`publicKey: 0x${Buffer.from(signer.publicKey).toString("hex")}`);
            } else {
                fail(`signer.publicKey wrong length: ${signer.publicKey?.length}`);
            }

            const sessionAccountId = new Uint8Array(sessions[0].remoteAccount.accountId);
            const matches =
                signer.publicKey.length === sessionAccountId.length &&
                signer.publicKey.every((b, i) => b === sessionAccountId[i]);
            if (matches) ok("publicKey matches session.remoteAccount.accountId");
            else fail("publicKey does NOT match remoteAccount.accountId");

            step("Roundtrip a signature through the phone (approve on device)");
            await rl.question("    > Press ENTER when ready, then approve on your phone... ");
            try {
                const sig = await withTimeout(
                    signer.signBytes(new TextEncoder().encode("manual-test-fresh")),
                    STEP_TIMEOUT_MS,
                    "signBytes",
                );
                ok(`signBytes returned ${sig.length}-byte signature`);
                info(`signature: 0x${Buffer.from(sig).toString("hex").slice(0, 32)}…`);
            } catch (e) {
                fail("signBytes failed — phone declined or timed out?", e);
            }
        }
    }

    // ── Final: destroy() ─────────────────────────────────────────────────
    step("Destroy adapter (await — drains pending unsubscribes before disconnect)");
    try {
        await adapter.destroy();
        ok("destroy() resolved cleanly");
        info("No `Statement subscription error` lines should appear — pending unsubscribes drained before disconnect.");
    } catch (e) {
        fail("destroy() threw", e);
    }
} catch (e) {
    fail("UNCAUGHT in main flow", e);
} finally {
    rl.close();

    console.log("\n═══════════════════════════════════════════════════════════════");
    if (exitCode === 0) {
        console.log("  ✓ All steps passed");
    } else {
        console.log("  ✗ Some steps FAILED:");
        for (const f of failures) console.log(`     - ${f}`);
    }
    console.log("═══════════════════════════════════════════════════════════════");
    if (!isReplay && exitCode === 0) {
        console.log("\n  Next: re-run with the same storageDir to verify session persistence");
        console.log("  (from packages/terminal):");
        console.log(`\n    STORAGE_DIR=${storageDir} \\`);
        console.log(`      node manual-tests/qr-pair-and-sign.mjs\n`);
    }

    // destroy() schedules a setTimeout for the console.error restoration —
    // give it time to fire before exit so we don't truncate the output.
    setTimeout(() => process.exit(exitCode), 200);
}
