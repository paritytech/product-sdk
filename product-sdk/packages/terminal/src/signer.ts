// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Transaction creators that sign as a product account through the paired
 * wallet. Transactions go to the core's `signing.createTransaction`, so the
 * wallet builds and shows the real extrinsic and keeps unknown extensions
 * such as `AsPgas`. Bytes go to `signing.signRaw` under the `Bytes` tag, so the
 * wallet adds the `<Bytes>` envelope once.
 */
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";
import { AllowanceExpiredError } from "@parity/product-sdk-signer/errors";
import { createHostTxCreator, type HostTxRequest } from "@parity/product-sdk-host/tx-creator";
import type { ProductAccountId, ProductAccountTxPayload } from "@parity/truapi";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { fromHex, toHex } from "@polkadot-api/utils";

import type { TerminalAdapter, TerminalSession } from "./adapter.js";
import { describeCallError } from "./call-error.js";

/** Which product account signs. */
export interface ProductAccountRef {
    /** The product, as a dotNS name. Usually the adapter's `appId`. */
    productId: string;
    /** Child index within the product; `0` is the default account. */
    derivationIndex: number;
    /** The account's public key when already known, which saves a round trip to the wallet. */
    publicKey?: Uint8Array;
}

export interface SessionSignerOptions {
    /**
     * Transaction extension version to sign on when the payload names none.
     * Defaults to `0`. A pipeline that cannot carry every supplied extension is
     * skipped for the lowest one that can.
     */
    txExtVersion?: number;
}

/** How long to wait for the wallet to answer the subtree key on a cold cache. */
const SUBTREE_TIMEOUT_MS = 120_000;

function productAccountId(ref: ProductAccountRef): ProductAccountId {
    return {
        dotNsIdentifier: ref.productId,
        derivationIndex: { tag: "Index", value: ref.derivationIndex },
    };
}

/** The wallet's root key for this session. Product accounts derive from per-product subtrees, not from it. */
export function sessionRootPublicKey(session: TerminalSession): Uint8Array {
    return fromHex(session.publicKey);
}

/** The product account's public key, derived from the product's subtree key the wallet shares. */
export async function deriveProductPublicKey(
    adapter: TerminalAdapter,
    ref: ProductAccountRef,
): Promise<Uint8Array> {
    const subtree = await adapter.runtime.getProductSubtreePublicKey(
        ref.productId,
        SUBTREE_TIMEOUT_MS,
    );
    if (!subtree) throw new Error("No paired session: log in before deriving a product account");
    return deriveProductAccountPublicKey(subtree, { tag: "Index", value: ref.derivationIndex });
}

/** The core's request for one signing round trip, from what the transaction creator hands over. */
export function buildTransactionPayload(
    signer: ProductAccountId,
    request: HostTxRequest,
): ProductAccountTxPayload {
    return {
        signer,
        genesisHash: request.genesisHash,
        callData: request.callData,
        extensions: request.extensions,
        txExtVersion: request.txExtVersion,
        contacts: [],
    };
}

/**
 * The core renews allowances itself, so a lapsed one surfaces only as a
 * failure naming it. Typed so callers can tell the user to re-pair.
 */
function signingError(what: string, error: unknown): Error {
    const description = describeCallError(error);
    if (/allowance/i.test(description)) return new AllowanceExpiredError("statementStore", error);
    return new Error(`${what} failed: ${description}`);
}

async function buildSessionSigner(
    adapter: TerminalAdapter,
    ref: ProductAccountRef,
    options: SessionSignerOptions = {},
): Promise<CommonSignerTxCreator> {
    const client = await adapter.client(ref.productId);
    const account = productAccountId(ref);
    // No fallback to the root key: that would sign valid bytes for the wrong address.
    const publicKey = ref.publicKey ?? (await deriveProductPublicKey(adapter, ref));

    return createHostTxCreator(
        publicKey,
        async (request) => {
            const signed = await client.signing.createTransaction(
                buildTransactionPayload(account, request),
            );
            if (signed.isErr()) throw signingError("Wallet transaction signing", signed.error);
            return signed.value.transaction;
        },
        async (data) => {
            const signed = await client.signing.signRaw({
                account,
                payload: { tag: "Bytes", value: { bytes: toHex(data) as `0x${string}` } },
            });
            if (signed.isErr()) throw signingError("Wallet signing", signed.error);
            return fromHex(signed.value.signature);
        },
        options.txExtVersion ?? 0,
    );
}

/** A transaction creator for the adapter's product, default account (`derivationIndex` 0). */
export function createSessionSigner(
    adapter: TerminalAdapter,
    publicKey?: Uint8Array,
    options?: SessionSignerOptions,
): Promise<CommonSignerTxCreator> {
    return buildSessionSigner(
        adapter,
        { productId: adapter.appId, derivationIndex: 0, publicKey },
        options,
    );
}

/** A transaction creator for any product account of the paired session. */
export function createSessionSignerForAccount(
    adapter: TerminalAdapter,
    ref: ProductAccountRef,
    options?: SessionSignerOptions,
): Promise<CommonSignerTxCreator> {
    return buildSessionSigner(adapter, ref, options);
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("buildTransactionPayload", () => {
        // Chain-specific extensions must reach the wallet untouched, or it signs
        // a different transaction than the one PAPI built.
        test("passes every extension and the extension version through unchanged", () => {
            const request: HostTxRequest = {
                genesisHash: `0x${"11".repeat(32)}`,
                callData: "0x0007",
                extensions: [
                    { id: "CheckGenesis", extra: "0x", additionalSigned: `0x${"11".repeat(32)}` },
                    { id: "AsPgas", extra: "0x0102", additionalSigned: "0x03" },
                ],
                txExtVersion: 1,
            };
            const signer = productAccountId({ productId: "my-cli.dot", derivationIndex: 2 });
            expect(buildTransactionPayload(signer, request)).toEqual({
                signer: {
                    dotNsIdentifier: "my-cli.dot",
                    derivationIndex: { tag: "Index", value: 2 },
                },
                genesisHash: request.genesisHash,
                callData: "0x0007",
                extensions: request.extensions,
                txExtVersion: 1,
                contacts: [],
            });
        });
    });

    describe("signingError", () => {
        test("names a lapsed allowance as AllowanceExpiredError and anything else plainly", () => {
            const lapsed = signingError("Wallet signing", {
                tag: "Unknown",
                value: { reason: "no allowance set for account" },
            });
            const rejected = signingError("Wallet signing", { tag: "Rejected" });
            expect([lapsed instanceof AllowanceExpiredError, rejected.message]).toEqual([
                true,
                "Wallet signing failed: Rejected",
            ]);
        });
    });

    describe("deriveProductPublicKey", () => {
        // Recorded from a live pairing on paseo-next-v2: the subtree key the
        // wallet shared for the product and the account getAccount returned for
        // index 0. A re-paired wallet keeps its product addresses.
        test("derives the account the wallet reports from the product's subtree key", async () => {
            const asked: unknown[] = [];
            const adapter = {
                runtime: {
                    async getProductSubtreePublicKey(productId: string) {
                        asked.push(productId);
                        return fromHex(
                            "0x8eeeae5cdf57b71cb2bd7be29a9cf91b5c2de138300501afdccda65e63fc9759",
                        );
                    },
                },
            } as unknown as TerminalAdapter;
            const publicKey = await deriveProductPublicKey(adapter, {
                productId: "terminal-live.dot",
                derivationIndex: 0,
            });
            expect({ asked, publicKey: toHex(publicKey) }).toEqual({
                asked: ["terminal-live.dot"],
                publicKey: "0xf2272710ab874f8d4bb4e59ba4e1b979b61f78d8a517ea134d245d6363312534",
            });
        });

        test("refuses to derive without a paired session", async () => {
            const adapter = {
                runtime: { getProductSubtreePublicKey: async () => undefined },
            } as unknown as TerminalAdapter;
            await expect(
                deriveProductPublicKey(adapter, { productId: "x.dot", derivationIndex: 0 }),
            ).rejects.toThrow("No paired session");
        });
    });
}
