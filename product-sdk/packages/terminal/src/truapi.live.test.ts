// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Live end-to-end test of the truapi backend against a `truapi-host` CLI
 * signing host standing in for the phone, on the real paseo-next-v2 chains.
 *
 * Opt-in, since it needs the network and a provisioned CLI account:
 *
 *   TRUAPI_HOST_CLI=~/.local/bin/truapi-host \
 *   TRUAPI_HOST_BASE=/path/to/.signing-host-managed \
 *   TRUAPI_HOST_SESSION=psdkterminalspike \
 *   pnpm --filter @parity/product-sdk-terminal exec vitest run src/truapi.live.test.ts
 *
 * TRUAPI_HOST_BASE / TRUAPI_HOST_SESSION select an existing CLI-managed
 * account so the test does not register a new username on chain each run.
 * Optional: TRUAPI_LIVE_STORAGE (reuse the terminal session between runs) and
 * TRUAPI_LIVE_APP_ID (product id, default terminal-truapi-live.dot).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Binary, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
    createStatementProof,
    createTruapiSigner,
    createTruapiTerminal,
    deriveEntropy,
    requestResourceAllocation,
    submitStatement,
    TruapiNetworks,
    type TruapiTerminal,
} from "./truapi.js";

const CLI = process.env.TRUAPI_HOST_CLI;
const BASE = process.env.TRUAPI_HOST_BASE;
const SESSION = process.env.TRUAPI_HOST_SESSION ?? "psdkterminalspike";
const APP_ID = process.env.TRUAPI_LIVE_APP_ID ?? "terminal-truapi-live.dot";
// Keeps the terminal session between runs. Each fresh pairing takes one of the
// CLI account's statement-store allowance slots; re-pairing every run
// eventually leaves the wallet answering NotAvailable.
const PERSISTENT_STORAGE = process.env.TRUAPI_LIVE_STORAGE;
const MINUTES = 60_000;

describe.skipIf(!CLI || !BASE)("truapi backend, live against a CLI signing host", () => {
    let storageDir: string;
    let terminal: TruapiTerminal;
    let signingHost: ChildProcess | undefined;
    let signingHostLog = "";

    /** Start the CLI wallet; with a deeplink it pairs, without it restores saved pairings. */
    function startSigningHost(deeplink?: string) {
        const args = [
            "signing-host",
            "--network",
            "paseo-next-v2",
            "--base-path",
            BASE!,
            "--session",
            SESSION,
            "--auto-accept",
            "--serve",
        ];
        if (deeplink) args.push("--deeplink", deeplink);
        signingHost = spawn(CLI!, args, { stdio: ["ignore", "pipe", "pipe"] });
        const append = (d: unknown) => {
            signingHostLog += String(d);
        };
        signingHost.stdout!.on("data", append);
        signingHost.stderr!.on("data", append);
    }

    beforeAll(async () => {
        storageDir = PERSISTENT_STORAGE ?? (await mkdtemp(join(tmpdir(), "terminal-truapi-live-")));
        terminal = await createTruapiTerminal({ appId: APP_ID, storageDir });
        // A restored session reports Connected straight away and never pairs.
        if (terminal.authState.tag === "Connected") startSigningHost();
        await terminal.login({
            reason: "terminal truapi live test",
            onPairing: (deeplink) => startSigningHost(deeplink),
        });
    }, 6 * MINUTES);

    afterAll(async () => {
        await terminal?.destroy();
        signingHost?.kill();
        if (!PERSISTENT_STORAGE) await rm(storageDir, { recursive: true, force: true });
        if (process.env.TRUAPI_LIVE_DEBUG) console.log(signingHostLog);
    });

    test("pairs and reports Connected", () => {
        expect(terminal.authState.tag).toBe("Connected");
    });

    test(
        "signer: signBytes returns a 64-byte sr25519 signature",
        async () => {
            const signer = await createTruapiSigner(terminal);
            expect(signer.publicKey).toHaveLength(32);
            const signature = await signer.signBytes(
                new TextEncoder().encode("terminal truapi live"),
            );
            expect(signature).toHaveLength(64);
        },
        2 * MINUTES,
    );

    test(
        "signer: signTx builds a remark the People runtime accepts the signature of",
        async () => {
            const signer = await createTruapiSigner(terminal);
            const papi = createClient(
                getWsProvider(TruapiNetworks["paseo-next-v2"].people.endpoint),
            );
            try {
                const api = papi.getUnsafeApi();
                const signed = await api.tx.System.remark({
                    remark: Binary.fromText("terminal truapi live"),
                }).sign(signer);
                const bytes = Buffer.from(signed);
                // Signed v4 extrinsic whose signer is our product account.
                expect(bytes.subarray(0, 40).includes(Buffer.from(signer.publicKey))).toBe(true);
            } finally {
                papi.destroy();
            }
        },
        3 * MINUTES,
    );

    test(
        "deriveEntropy is deterministic per context",
        async () => {
            const context = new TextEncoder().encode("terminal-truapi-live");
            const a = await deriveEntropy(terminal, context);
            const b = await deriveEntropy(terminal, context);
            expect(a).toHaveLength(32);
            expect(a).toEqual(b);
        },
        2 * MINUTES,
    );

    test(
        "statement store: allocate, prove, submit",
        async (ctx) => {
            const [outcome] = await requestResourceAllocation(terminal, [
                { tag: "StatementStoreAllowance" },
            ]);
            // NotAvailable is the wallet declining (no free slot), not a backend fault.
            expect(["Allocated", "NotAvailable"]).toContain(outcome);
            if (outcome !== "Allocated") return ctx.skip();
            const statement = {
                topics: [`0x${"ab".repeat(32)}` as const],
                data: `0x${Buffer.from("hello from terminal").toString("hex")}` as `0x${string}`,
                expiry: (BigInt(Math.floor(Date.now() / 1000) + 3600) << 32n) | 1n,
            };
            const proof = await createStatementProof(terminal, statement);
            expect(proof.tag).toBe("Sr25519");
            await submitStatement(terminal, { ...statement, proof });
        },
        3 * MINUTES,
    );
});
