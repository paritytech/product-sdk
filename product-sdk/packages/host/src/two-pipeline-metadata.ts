// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test fixture: a real metadata blob rewritten to declare two extension pipelines.
 *
 * People runtime 3004000 declares version 0 as the plain account pipeline and
 * version 1 as the full one with the person extensions. No checked-in blob
 * declares two versions yet, so the in-source tests build one from a real blob
 * rather than from a hand-written type. Imported only from test blocks, so the
 * published bundle never contains it.
 */
import { decAnyMetadata, metadata as metadataCodec } from "@polkadot-api/substrate-bindings";

/** The version 0 pipeline of People runtime 3004000, read off previewnet on 2026-10-12. */
const PLAIN_ACCOUNT_PIPELINE = new Set([
    "AuthorizeCall",
    "CheckNonZeroSender",
    "CheckSpecVersion",
    "CheckTxVersion",
    "CheckGenesis",
    "CheckMortality",
    "CheckNonce",
    "CheckWeight",
    "ChargeAssetTxPayment",
    "CheckMetadataHash",
    "StorageWeightReclaim",
]);

/**
 * Rewrite a v16 blob so version 0 holds the plain account extensions and
 * version 1 holds every extension, in the order the blob declares them.
 */
export function withTwoPipelines(blob: Uint8Array): Uint8Array {
    const decoded = decAnyMetadata(blob);
    if (decoded.metadata.tag !== "v16") {
        throw new Error("two pipelines need a v16 blob");
    }
    const runtime = decoded.metadata.value;
    const all = runtime.extrinsic.signedExtensions.map((_, index) => index);
    const plain = all.filter((index) =>
        PLAIN_ACCOUNT_PIPELINE.has(runtime.extrinsic.signedExtensions[index].identifier),
    );

    return metadataCodec.enc({
        ...decoded,
        metadata: {
            tag: "v16",
            value: {
                ...runtime,
                extrinsic: {
                    ...runtime.extrinsic,
                    signedExtensionsByVersion: [
                        [0, plain],
                        [1, all],
                    ],
                },
            },
        },
    });
}
