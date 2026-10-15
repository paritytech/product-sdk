// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test harness for the wrapping signers: drives a PAPI 3 `TxCreator` from the
 * extension map the wrappers work in, and records what reached the inner signer.
 *
 * Imported only from in-source test blocks, so no published entry contains it.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import type { TxPayloadV1 } from "@polkadot-api/tx-creator";
import { fromHex, toHex } from "@polkadot-api/utils";

import type { PapiSignedExtensions } from "./as-person-implication.js";

/** What the inner signer was handed, back in the shape the assertions read. */
export interface InnerCall {
    callData: Uint8Array;
    extensions: PapiSignedExtensions;
    txExtVersion: number | null;
}

/** An inner signer that records each payload and answers `0xdead`. */
export function spyCreator(publicKey: Uint8Array, signBytes: CommonSignerTxCreator["signBytes"]) {
    const calls: InnerCall[] = [];
    const create = async (payload: TxPayloadV1) => {
        calls.push({
            callData: fromHex(payload.callData),
            extensions: Object.fromEntries(
                payload.extensions.map(({ id, extra, additionalSigned }) => [
                    id,
                    {
                        identifier: id,
                        value: fromHex(extra),
                        additionalSigned: fromHex(additionalSigned),
                    },
                ]),
            ),
            txExtVersion: payload.txExtVersion,
        });
        return "0xdead";
    };
    const signer = Object.assign(create, {
        publicKey,
        signBytes,
    }) as unknown as CommonSignerTxCreator;
    return { signer, calls };
}

const metadataHex = new WeakMap<Uint8Array, string>();

/**
 * Run `creator` on one transaction, the way PAPI 3 would after its enhancers ran.
 *
 * Every extension is supplied, so no enhancer needs the chain bindings. The
 * metadata hex is cached per array, as PAPI reuses one string per runtime.
 */
export function signTx(
    creator: CommonSignerTxCreator,
    callData: Uint8Array,
    extensions: PapiSignedExtensions,
    metadata: Uint8Array,
    options: { nonce?: number } = {},
): Promise<string> {
    if (!metadataHex.has(metadata)) metadataHex.set(metadata, toHex(metadata));
    const payload: TxPayloadV1 = {
        version: 1,
        signer: null,
        callData: toHex(callData),
        extensions: Object.values(extensions).map(({ identifier, value, additionalSigned }) => ({
            id: identifier,
            extra: toHex(value),
            additionalSigned: toHex(additionalSigned),
        })),
        txExtVersion: null,
        context: {
            metadata: metadataHex.get(metadata) as string,
            token: null,
            bestBlockHeight: 1,
            bestBlockHash: `0x${"11".repeat(32)}`,
            genesisHash: `0x${"22".repeat(32)}`,
        },
    };
    return creator(payload, options as never, {} as never, false);
}
