// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Which transaction-extension pipeline version a set of signed extensions belongs to.
 *
 * The host needs that version to build the extrinsic, and PAPI's `signTx` does
 * not pass it. A chain that declares one pipeline always answers 0. People
 * runtime 3004000 declares two: version 0 holds the plain account extensions and
 * version 1 adds the person extensions. A transaction carrying `AsPerson` is
 * therefore a version 1 transaction, and the only way to tell is to compare the
 * extensions against what the metadata declares.
 *
 * Also published as the `@parity/product-sdk-host/tx-ext-version` subpath,
 * which loads no host transport, for signers that run outside a host.
 *
 * @module
 */
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";

type DeclaredPipelines = Array<{ version: number; identifiers: Set<string> }>;

/**
 * Keyed on the array PAPI hands to every `signTx` until the runtime upgrades, so
 * each runtime decodes once and an upgrade cannot be served a stale entry.
 */
const pipelinesByMetadata = new WeakMap<Uint8Array, DeclaredPipelines | undefined>();

function declaredPipelines(metadata: Uint8Array): DeclaredPipelines | undefined {
    if (pipelinesByMetadata.has(metadata)) return pipelinesByMetadata.get(metadata);

    let pipelines: DeclaredPipelines | undefined;
    try {
        const { signedExtensions } = unifyMetadata(decAnyMetadata(metadata)).extrinsic;
        pipelines = Object.entries(signedExtensions)
            .map(([version, extensions]) => ({
                version: Number(version),
                identifiers: new Set(extensions.map((extension) => extension.identifier)),
            }))
            .sort((a, b) => a.version - b.version);
    } catch {
        // A blob this cannot read keeps the version 0 every signer sent before
        // chains declared more than one pipeline.
        pipelines = undefined;
    }
    pipelinesByMetadata.set(metadata, pipelines);
    return pipelines;
}

/**
 * The lowest pipeline version declaring every one of `signedExtensions`, or 0
 * when none does or the metadata does not decode.
 *
 * @param metadata - the raw metadata PAPI passes to `PolkadotSigner.signTx`.
 * @param signedExtensions - the extensions PAPI passes alongside it, keyed by identifier.
 */
export function resolveTxExtVersion(
    metadata: Uint8Array | undefined,
    signedExtensions: Record<string, unknown>,
): number {
    if (!metadata) return 0;
    const supplied = Object.keys(signedExtensions);
    const match = declaredPipelines(metadata)?.find(({ identifiers }) =>
        supplied.every((identifier) => identifiers.has(identifier)),
    );
    return match?.version ?? 0;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { readFileSync } = await import("node:fs");
    const { withTwoPipelines } = await import("./two-pipeline-metadata.js");

    // A real blob from the descriptors package. This is the one place a host
    // test reads outside the package.
    const PASEO = new Uint8Array(
        readFileSync(
            new URL("../../descriptors/.papi/metadata/paseo_individuality.scale", import.meta.url),
        ),
    );

    const TWO_PIPELINES = withTwoPipelines(PASEO);
    const keys = (...identifiers: string[]) =>
        Object.fromEntries(identifiers.map((identifier) => [identifier, {}]));

    describe("resolveTxExtVersion", () => {
        test("a plain account transaction on a two-pipeline chain is version 0", () => {
            expect(
                resolveTxExtVersion(
                    TWO_PIPELINES,
                    keys("CheckGenesis", "CheckNonce", "CheckWeight"),
                ),
            ).toBe(0);
        });

        test("a transaction carrying AsPerson on a two-pipeline chain is version 1", () => {
            expect(
                resolveTxExtVersion(TWO_PIPELINES, keys("CheckGenesis", "CheckNonce", "AsPerson")),
            ).toBe(1);
        });

        test("a single-pipeline chain is version 0 whatever the extensions", () => {
            expect(resolveTxExtVersion(PASEO, keys("CheckNonce", "AsPerson"))).toBe(0);
        });

        test("extensions no version declares fall back to 0", () => {
            expect(resolveTxExtVersion(TWO_PIPELINES, keys("AsPgas"))).toBe(0);
        });

        test("metadata that does not decode, or none at all, falls back to 0", () => {
            expect(resolveTxExtVersion(new Uint8Array([0x6d]), keys("AsPerson"))).toBe(0);
            expect(resolveTxExtVersion(new Uint8Array(), keys("AsPerson"))).toBe(0);
            expect(resolveTxExtVersion(undefined, keys("AsPerson"))).toBe(0);
        });
    });
}
