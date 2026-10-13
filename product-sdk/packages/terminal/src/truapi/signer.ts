// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `PolkadotSigner` over the truapi backend: the truapi counterpart of
 * `createSessionSigner` / `createSessionSignerForAccount`.
 *
 * Transactions go to `signing.createTransaction`, so the wallet builds and
 * signs the real extrinsic (unknown signed extensions survive, no `<Bytes>`
 * envelope). Arbitrary bytes go to `signing.signRaw` under the `Bytes` tag.
 */
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";
import type { ProductAccountTxPayload } from "@parity/truapi";
import type { PolkadotSigner } from "polkadot-api";

import type { TruapiTerminal } from "./runtime.js";

export interface TruapiAccountRef {
    /** Product id. Defaults to the terminal's `appId`. */
    productId?: string;
    /** Child-key derivation index. Defaults to `0`. */
    derivationIndex?: number;
    /** Known product-account public key; skips the subtree lookup when given. */
    publicKey?: Uint8Array;
    /** Extension version of the signed extensions PAPI passes. Defaults to `0`. */
    txExtVersion?: number;
}

type SignedExtensions = Parameters<PolkadotSigner["signTx"]>[1];
type Hex = `0x${string}`;

const toHex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString("hex")}`;
const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex.slice(2), "hex"));

/** Map PAPI's `signTx` arguments onto truapi's `ProductAccountTxPayload`. */
export function buildProductTxPayload(
    signer: ProductAccountTxPayload["signer"],
    callData: Uint8Array,
    signedExtensions: SignedExtensions,
    txExtVersion: number,
): ProductAccountTxPayload {
    const checkGenesis = signedExtensions.CheckGenesis;
    if (!checkGenesis) {
        throw new Error(
            "Cannot build transaction: chain did not provide the CheckGenesis signed extension",
        );
    }
    return {
        signer,
        // CheckGenesis carries the genesis hash as its additionalSigned data.
        genesisHash: toHex(checkGenesis.additionalSigned),
        callData: toHex(callData),
        extensions: Object.values(signedExtensions).map(
            ({ identifier, value, additionalSigned }) => ({
                id: identifier,
                extra: toHex(value),
                additionalSigned: toHex(additionalSigned),
            }),
        ),
        txExtVersion,
        contacts: [],
    };
}

const describe = (error: unknown) => JSON.stringify(error);

export async function createTruapiSigner(
    terminal: TruapiTerminal,
    ref: TruapiAccountRef = {},
): Promise<PolkadotSigner> {
    const productId = ref.productId ?? terminal.appId;
    const derivationIndex = ref.derivationIndex ?? 0;
    const account = {
        dotNsIdentifier: productId,
        derivationIndex: { tag: "Index" as const, value: derivationIndex },
    };

    // Same derivation as the host-papp backend's deriveProductPublicKey, so a
    // product address does not change when a CLI switches backends.
    const publicKey =
        ref.publicKey ??
        deriveProductAccountPublicKey(await terminal.productSubtreePublicKey(productId), {
            tag: "Index",
            value: derivationIndex,
        });

    return {
        publicKey,
        async signTx(callData, signedExtensions) {
            const payload = buildProductTxPayload(
                account,
                callData,
                signedExtensions,
                ref.txExtVersion ?? 0,
            );
            const result = await terminal.client.signing.createTransaction(payload);
            if (result.isErr())
                throw new Error(`Wallet transaction signing failed: ${describe(result.error)}`);
            return fromHex(result.value.transaction);
        },
        async signBytes(data) {
            const result = await terminal.client.signing.signRaw({
                account,
                payload: { tag: "Bytes", value: { bytes: toHex(data) } },
            });
            if (result.isErr()) throw new Error(`Wallet signing failed: ${describe(result.error)}`);
            return fromHex(result.value.signature);
        },
    };
}

if (import.meta.vitest) {
    const { describe: suite, test, expect } = import.meta.vitest;

    const ext = (identifier: string, value: number[], additionalSigned: number[]) => ({
        identifier,
        value: new Uint8Array(value),
        additionalSigned: new Uint8Array(additionalSigned),
    });

    suite("buildProductTxPayload", () => {
        const signer = {
            dotNsIdentifier: "my-cli.dot",
            derivationIndex: { tag: "Index" as const, value: 0 },
        };

        test("takes the genesis hash from CheckGenesis and keeps every extension in order", () => {
            const genesis = Array.from({ length: 32 }, (_, i) => i);
            const payload = buildProductTxPayload(
                signer,
                new Uint8Array([0x00, 0x07]),
                {
                    CheckNonce: ext("CheckNonce", [4], []),
                    CheckGenesis: ext("CheckGenesis", [], genesis),
                    AsPgas: ext("AsPgas", [1, 2], [3]),
                } as SignedExtensions,
                1,
            );
            expect(payload.genesisHash).toBe(toHex(new Uint8Array(genesis)));
            expect(payload.callData).toBe("0x0007");
            expect(payload.extensions).toEqual([
                { id: "CheckNonce", extra: "0x04", additionalSigned: "0x" },
                {
                    id: "CheckGenesis",
                    extra: "0x",
                    additionalSigned: toHex(new Uint8Array(genesis)),
                },
                { id: "AsPgas", extra: "0x0102", additionalSigned: "0x03" },
            ]);
            expect(payload.txExtVersion).toBe(1);
            expect(payload.contacts).toEqual([]);
        });

        test("refuses a chain without CheckGenesis", () => {
            expect(() =>
                buildProductTxPayload(signer, new Uint8Array(), {} as SignedExtensions, 0),
            ).toThrow(/CheckGenesis/);
        });
    });

    suite("product account derivation parity", () => {
        test("subtree key -> product account matches what truapi's getAccount returned live", () => {
            // Recorded from a live pairing on paseo-next-v2 (truapi-host 0.24.0):
            // productSubtreePublicKey("terminal-spike.dot") and getAccount(index 0).
            const subtree = fromHex(
                "0x8eeeae5cdf57b71cb2bd7be29a9cf91b5c2de138300501afdccda65e63fc9759",
            );
            expect(toHex(deriveProductAccountPublicKey(subtree, { tag: "Index", value: 0 }))).toBe(
                "0xf2272710ab874f8d4bb4e59ba4e1b979b61f78d8a517ea134d245d6363312534",
            );
        });
    });
}
