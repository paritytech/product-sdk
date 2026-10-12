// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A PAPI 3 `TxCreator` that hands the finished extension list to the host to sign.
 *
 * PAPI 3 passes every transaction to its creator as a `TxPayloadV1`: call data,
 * an extension list, the pipeline version those extensions belong to, and the
 * runtime metadata. That is almost exactly the shape the host signs, so the
 * creator fills the standard extensions with the PAPI enhancers, keeps the ones
 * the chosen pipeline declares, and forwards them with the version unchanged.
 *
 * A caller that writes its own extensions, such as the person-origin wrappers in
 * `@parity/product-sdk-individuality`, sets `txExtVersion` on the payload, and
 * the host is told that version rather than one guessed from the extension names.
 *
 * Fee estimation runs the creator with a mocked signature. That never reaches
 * the host, because a host call can prompt the user. It builds the same
 * extrinsic locally with a zero signature instead, which has the right length.
 *
 * Also published as `@parity/product-sdk-host/tx-creator`, which loads no host
 * transport, for the terminal signer that talks to a paired phone instead.
 *
 * @module
 */
import {
    type CommonSignerTxCreator,
    withCommonExtensions,
    withNonce,
} from "@polkadot-api/signers-common";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { TxCreator, TxPayloadV1 } from "@polkadot-api/tx-creator";
import { getTxCreator, getVerifyMultiSignatureTxCreator } from "polkadot-api/tx-creator";

/** One extension as the host signs it. */
export interface HostTxExtension {
    id: string;
    extra: `0x${string}`;
    additionalSigned: `0x${string}`;
}

/** What the host needs to build and sign one transaction. */
export interface HostTxRequest {
    genesisHash: `0x${string}`;
    callData: `0x${string}`;
    extensions: HostTxExtension[];
    txExtVersion: number;
}

/**
 * Build a creator that signs through `sendToHost`.
 *
 * @param publicKey - the account the host signs with, used for the nonce and the mocked signature.
 * @param sendToHost - one host round trip, returning the signed extrinsic as hex.
 * @param signBytes - raw byte signing for the same account.
 * @param defaultTxExtVersion - the version to use when the payload names none.
 */
export function createHostTxCreator(
    publicKey: Uint8Array,
    sendToHost: (request: HostTxRequest) => Promise<`0x${string}`>,
    signBytes: (data: Uint8Array) => Promise<Uint8Array>,
    defaultTxExtVersion = 0,
): CommonSignerTxCreator {
    const neverSigns = (): Uint8Array => {
        throw new Error("a mocked transaction must not be signed");
    };
    const mockedV4 = getTxCreator(publicKey, "Sr25519", neverSigns);
    const mockedV5 = getVerifyMultiSignatureTxCreator(publicKey, "Sr25519", neverSigns);

    const create: TxCreator<[]> = async (payload, opts, bindings, mocked) => {
        const txExtVersion = payload.txExtVersion ?? defaultTxExtVersion;
        if (mocked) {
            const withVersion = { ...payload, txExtVersion };
            return txExtVersion === 0
                ? mockedV4(withVersion, opts as never, bindings, true)
                : mockedV5(
                      withVersion,
                      { ...opts, extensionVersion: txExtVersion } as never,
                      bindings,
                      true,
                  );
        }
        return sendToHost({
            genesisHash: payload.context.genesisHash as `0x${string}`,
            callData: payload.callData as `0x${string}`,
            extensions: pipelineExtensions(payload, txExtVersion),
            txExtVersion,
        });
    };

    return Object.assign(withNonce(publicKey)(withCommonExtensions(create)), {
        publicKey,
        signBytes,
    });
}

/**
 * The payload extensions the pipeline at `txExtVersion` declares, in its order.
 *
 * The PAPI enhancers fill every extension any pipeline declares, so a two-pipeline
 * chain such as People runtime 3004000 hands over slots the chosen version does
 * not carry. `VerifyMultiSignature` stays out unless the payload set it, because
 * the host signs into that slot itself.
 */
function pipelineExtensions(payload: TxPayloadV1, txExtVersion: number): HostTxExtension[] {
    const declared = unifyMetadata(decAnyMetadata(payload.context.metadata)).extrinsic
        .extensionsByVersion[txExtVersion];
    if (!declared) {
        throw new Error(`chain declares no transaction-extension pipeline version ${txExtVersion}`);
    }
    const supplied = new Map(payload.extensions.map((extension) => [extension.id, extension]));
    return declared.flatMap(({ identifier }) => {
        const extension = supplied.get(identifier);
        return extension
            ? [
                  {
                      id: extension.id,
                      extra: extension.extra as `0x${string}`,
                      additionalSigned: extension.additionalSigned as `0x${string}`,
                  },
              ]
            : [];
    });
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { toHex } = await import("./truapi.js");

    // People runtime 3004000: version 0 holds the plain account extensions,
    // version 1 adds the person and origin ones.
    const PEOPLE = toHex(
        new Uint8Array(
            readFileSync(
                new URL(
                    "../../descriptors/.papi/metadata/previewnet_individuality.scale",
                    import.meta.url,
                ),
            ),
        ),
    );
    const pipelines = unifyMetadata(decAnyMetadata(PEOPLE)).extrinsic.extensionsByVersion;
    const everyExtension = [...new Set(pipelines[1].map(({ identifier }) => identifier))]
        .filter((identifier) => identifier !== "VerifyMultiSignature")
        .map((identifier, index) => ({
            id: identifier,
            extra: toHex(new Uint8Array([index])),
            additionalSigned: "0x",
        }));
    const payloadAt = (txExtVersion: number | null): TxPayloadV1 => ({
        version: 1,
        signer: null,
        callData: "0xca11",
        extensions: everyExtension,
        txExtVersion,
        context: {
            metadata: PEOPLE,
            token: null,
            bestBlockHeight: 1,
            bestBlockHash: `0x${"11".repeat(32)}`,
            genesisHash: `0x${"22".repeat(32)}`,
        },
    });
    const noBindings = {} as Parameters<TxCreator>[2];

    function hostSpy() {
        const requests: HostTxRequest[] = [];
        const creator = createHostTxCreator(
            new Uint8Array(32).fill(0xaa),
            async (request) => {
                requests.push(request);
                return "0xdead";
            },
            async () => new Uint8Array(64),
        );
        return { creator, requests };
    }

    describe("createHostTxCreator", () => {
        test("a plain transaction signs on pipeline version 0 with only its extensions", async () => {
            const { creator, requests } = hostSpy();
            await creator(payloadAt(null), {}, noBindings, false);
            expect(requests[0].txExtVersion).toBe(0);
            expect(requests[0].extensions.map(({ id }) => id)).toEqual(
                pipelines[0].map(({ identifier }) => identifier),
            );
        });

        test("the version on the payload wins and selects that pipeline", async () => {
            const { creator, requests } = hostSpy();
            await creator(payloadAt(1), {}, noBindings, false);
            expect(requests[0].txExtVersion).toBe(1);
            expect(requests[0].extensions.map(({ id }) => id)).toEqual(
                pipelines[1]
                    .map(({ identifier }) => identifier)
                    .filter((identifier) => identifier !== "VerifyMultiSignature"),
            );
        });

        test("a VerifyMultiSignature the payload sets is forwarded, so the host signs nothing", async () => {
            const { creator, requests } = hostSpy();
            const disabled = { id: "VerifyMultiSignature", extra: "0x00", additionalSigned: "0x" };
            const payload = payloadAt(1);
            await creator(
                { ...payload, extensions: [...payload.extensions, disabled] },
                {},
                noBindings,
                false,
            );
            expect(requests[0].extensions[1]).toEqual(disabled);
        });

        test("a fee estimate never reaches the host", async () => {
            const { creator, requests } = hostSpy();
            const hasher = vi.fn();
            const estimate = await creator(payloadAt(null), {}, { hasher } as never, true);
            expect(requests).toHaveLength(0);
            expect(estimate.startsWith("0x")).toBe(true);
        });

        test("a version the chain does not declare is refused before the host is asked", async () => {
            const { creator, requests } = hostSpy();
            await expect(creator(payloadAt(7), {}, noBindings, false)).rejects.toThrow(
                /no transaction-extension pipeline version 7/,
            );
            expect(requests).toHaveLength(0);
        });
    });
}
