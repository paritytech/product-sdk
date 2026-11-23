// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal end to end against a real wallet: the truapi CLI signing host
 * pairs with it over live paseo-next-v2, then answers every call the terminal
 * makes. Opt-in, since it needs the network and a provisioned CLI account:
 *
 *   TRUAPI_HOST_CLI=~/.local/bin/truapi-host \
 *   TRUAPI_HOST_BASE=/path/to/signing-host-base TRUAPI_HOST_SESSION=<name> \
 *   pnpm --filter @parity/product-sdk-terminal exec vitest run src/terminal.live.test.ts
 *
 * TERMINAL_LIVE_STORAGE keeps the terminal's session between runs. Without it
 * each run pairs a new device and unpairs it at the end; the wallet allows a
 * limited number of new devices per allowance period.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
    createSessionSigner,
    createTerminalAdapter,
    deriveEntropy,
    deriveProductPublicKey,
    getStatementStoreProver,
    requestResourceAllocation,
    submitStatement,
    TerminalNetworks,
    type TerminalAdapter,
} from "./index.js";

const { TRUAPI_HOST_CLI, TRUAPI_HOST_BASE, TRUAPI_HOST_SESSION, TERMINAL_LIVE_STORAGE } =
    process.env;
const APP_ID = "terminal-live.dot";
const MINUTE = 60_000;
const PEOPLE = TerminalNetworks["paseo-next-v2"].people;

/**
 * Whether the People runtime accepts the extrinsic's signature, by asking it
 * to validate the transaction without submitting it. The test account holds no
 * funds, so `Payment` is the only refusal that still means a good signature.
 */
async function signatureAccepted(extrinsic: Uint8Array): Promise<string> {
    const rpc = async (method: string, params: unknown[]) => {
        const response = await fetch(PEOPLE.endpoint.replace(/^wss:/, "https:"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        });
        return ((await response.json()) as { result: string }).result;
    };
    const head = await rpc("chain_getFinalizedHead", []);
    const external = "02";
    const answer = await rpc("state_call", [
        "TaggedTransactionQueue_validate_transaction",
        `0x${external}${Buffer.from(extrinsic).toString("hex")}${head.slice(2)}`,
        head,
    ]);
    const bytes = Buffer.from(answer.slice(2), "hex");
    if (bytes[0] === 0) return "valid";
    const invalid = [
        "Call",
        "Payment",
        "Future",
        "Stale",
        "BadProof",
        "AncientBirthBlock",
        "ExhaustsResources",
        "Custom",
        "BadMandatory",
        "MandatoryValidation",
        "BadSigner",
    ];
    return bytes[1] === 0 ? (invalid[bytes[2]!] ?? String(bytes[2])) : `Unknown(${bytes[2]})`;
}

describe.skipIf(!TRUAPI_HOST_CLI || !TRUAPI_HOST_BASE)(
    "terminal against a CLI signing host",
    () => {
        let storageDir: string;
        let adapter: TerminalAdapter;
        let signingHost: ChildProcess | undefined;

        function startSigningHost(deeplink?: string) {
            signingHost = spawn(
                TRUAPI_HOST_CLI!,
                [
                    "signing-host",
                    "--network",
                    "paseo-next-v2",
                    "--base-path",
                    TRUAPI_HOST_BASE!,
                    ...(TRUAPI_HOST_SESSION ? ["--session", TRUAPI_HOST_SESSION] : []),
                    "--auto-accept",
                    "--serve",
                    ...(deeplink ? ["--deeplink", deeplink] : []),
                ],
                { stdio: "ignore" },
            );
        }

        beforeAll(async () => {
            storageDir = TERMINAL_LIVE_STORAGE ?? (await mkdtemp(join(tmpdir(), "terminal-live-")));
            adapter = await createTerminalAdapter({ appId: APP_ID, storageDir });
            // A restored session never pairs again; the wallet must still be listening.
            if (adapter.session) startSigningHost();
            await adapter.login({
                reason: "terminal live test",
                onPairing: (link) => startSigningHost(link),
            });
        }, 6 * MINUTE);

        afterAll(async () => {
            // A session that is not kept is unpaired, so it does not hold one of
            // the wallet's device slots.
            if (!TERMINAL_LIVE_STORAGE) await adapter?.logout().catch(() => {});
            await adapter?.destroy();
            signingHost?.kill();
            if (!TERMINAL_LIVE_STORAGE) await rm(storageDir, { recursive: true, force: true });
        });

        test(
            "a remark signed through the wallet carries a signature the People runtime accepts",
            async () => {
                const signer = await createSessionSigner(adapter);
                expect(signer.publicKey).toEqual(
                    await deriveProductPublicKey(adapter, {
                        productId: APP_ID,
                        derivationIndex: 0,
                    }),
                );
                const people = createClient(getWsProvider(PEOPLE.endpoint));
                try {
                    const remark = people
                        .getUnsafeApi()
                        .tx.System.remark({ remark: new TextEncoder().encode("terminal live") });
                    expect(["valid", "Payment"]).toContain(
                        await signatureAccepted(await remark.create(signer)),
                    );
                } finally {
                    people.destroy();
                }
            },
            3 * MINUTE,
        );

        test(
            "raw bytes come back with a 64-byte signature",
            async () => {
                const signer = await createSessionSigner(adapter);
                expect(
                    await signer.signBytes(new TextEncoder().encode("terminal live")),
                ).toHaveLength(64);
            },
            2 * MINUTE,
        );

        // Same wallet, product and key must give the same bytes on every call.
        test(
            "entropy is 32 bytes and stable per key",
            async () => {
                const key = new TextEncoder().encode("terminal-live");
                const [first, second] = [
                    await deriveEntropy(adapter, APP_ID, key),
                    await deriveEntropy(adapter, APP_ID, key),
                ];
                expect({
                    length: first.length,
                    stable: Buffer.from(first).equals(Buffer.from(second)),
                }).toEqual({
                    length: 32,
                    stable: true,
                });
            },
            2 * MINUTE,
        );

        test(
            "a statement proved with the product's allowance is accepted by the statement store",
            async (context) => {
                const [outcome] = await requestResourceAllocation(adapter, [
                    { tag: "StatementStoreAllowance" },
                ]);
                // The wallet declines when the account has no free slot; that is its answer, not a fault.
                expect(["Allocated", "NotAvailable"]).toContain(outcome);
                if (outcome !== "Allocated") return context.skip();
                const statement = {
                    topics: [`0x${"ab".repeat(32)}` as const],
                    data: `0x${Buffer.from("hello from terminal").toString("hex")}` as `0x${string}`,
                    expiry: (BigInt(Math.floor(Date.now() / 1000) + 3600) << 32n) | 1n,
                };
                const proof = await (await getStatementStoreProver(adapter)).createProof(statement);
                await submitStatement(adapter, { ...statement, proof });
            },
            3 * MINUTE,
        );
    },
);
