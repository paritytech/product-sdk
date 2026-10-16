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
 * A payload that names no version signs on the preferred pipeline when that
 * carries every extension the caller supplied, and otherwise on the lowest
 * pipeline that does. On Asset Hub runtime 3004000 that lifts a transaction
 * carrying `AsPgas` to version 1, because version 0 does not declare it.
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
import {
    type UnifiedMetadata,
    decAnyMetadata,
    unifyMetadata,
} from "@polkadot-api/substrate-bindings";
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
 * @param preferredTxExtVersion - the version to sign on when the payload names none and that pipeline carries every supplied extension.
 */
export function createHostTxCreator(
    publicKey: Uint8Array,
    sendToHost: (request: HostTxRequest) => Promise<`0x${string}`>,
    signBytes: (data: Uint8Array) => Promise<Uint8Array>,
    preferredTxExtVersion = 0,
): CommonSignerTxCreator {
    const neverSigns = (): Uint8Array => {
        throw new Error("a mocked transaction must not be signed");
    };
    const mockedV4 = getTxCreator(publicKey, "Sr25519", neverSigns);
    const mockedV5 = getVerifyMultiSignatureTxCreator(publicKey, "Sr25519", neverSigns);
    const pipelinesOf = cachedPipelines();

    const create: TxCreator<[]> = async (payload, opts, bindings, mocked) => {
        const txExtVersion = payload.txExtVersion ?? preferredTxExtVersion;
        const declared = pipelinesOf(payload.context.metadata)[txExtVersion];
        if (!declared) {
            throw new Error(
                `chain declares no transaction-extension pipeline version ${txExtVersion}`,
            );
        }
        if (mocked) {
            // A pipeline without VerifyMultiSignature is authorized by some other
            // extension, so it is priced as the plain account transaction it would
            // otherwise be.
            const signsInPipeline = declared.some(
                ({ identifier }) => identifier === "VerifyMultiSignature",
            );
            return signsInPipeline
                ? mockedV5(
                      { ...payload, txExtVersion },
                      { ...opts, extensionVersion: txExtVersion } as never,
                      bindings,
                      true,
                  )
                : mockedV4({ ...payload, txExtVersion: 0 }, opts as never, bindings, true);
        }
        return sendToHost({
            genesisHash: payload.context.genesisHash as `0x${string}`,
            callData: payload.callData as `0x${string}`,
            extensions: pipelineExtensions(payload, declared),
            txExtVersion,
        });
    };

    const signer = withNonce(publicKey)(withCommonExtensions(create));
    // The choice reads the payload before the enhancers run, because they fill
    // a default for every extension any pipeline declares and every version
    // would then look equally well supplied.
    const choosing: typeof signer = async (payload, opts, bindings, mocked) =>
        signer(
            payload.txExtVersion == null
                ? {
                      ...payload,
                      txExtVersion: chooseVersion(
                          pipelinesOf(payload.context.metadata),
                          suppliedExtensionIds(payload, opts),
                          preferredTxExtVersion,
                      ),
                  }
                : payload,
            opts,
            bindings,
            mocked,
        );

    return Object.assign(choosing, { publicKey, signBytes });
}

type Pipelines = UnifiedMetadata["extrinsic"]["extensionsByVersion"];

/** Decode each metadata blob once, since PAPI hands the same one until the runtime upgrades. */
function cachedPipelines(): (metadata: string) => Pipelines {
    let cached: { metadata: string; pipelines: Pipelines } | undefined;
    return (metadata) => {
        if (cached?.metadata !== metadata) {
            cached = {
                metadata,
                pipelines: unifyMetadata(decAnyMetadata(metadata)).extrinsic.extensionsByVersion,
            };
        }
        return cached.pipelines;
    };
}

/**
 * The extensions the caller wrote, on the payload or as PAPI `customSignedExtensions`.
 *
 * A falsy entry is skipped, as the PAPI enhancer that encodes them skips it.
 */
function suppliedExtensionIds(payload: TxPayloadV1, opts: unknown): string[] {
    const custom =
        (opts as { customSignedExtensions?: Record<string, unknown> } | undefined)
            ?.customSignedExtensions ?? {};
    return [
        ...new Set([
            ...payload.extensions.map(({ id }) => id),
            ...Object.keys(custom).filter((id) => custom[id]),
        ]),
    ];
}

/**
 * The preferred version when its pipeline carries every supplied extension, else the lowest that does.
 *
 * Mirrors `withChooseTxVersion` in the PAPI signers. An undeclared preferred
 * version is returned as is, so signing refuses it by number.
 */
function chooseVersion(pipelines: Pipelines, supplied: string[], preferred: number): number {
    const carriesAll = (version: number) =>
        supplied.every((id) => pipelines[version].some(({ identifier }) => identifier === id));
    if (!pipelines[preferred] || carriesAll(preferred)) return preferred;
    const version = Object.keys(pipelines)
        .map(Number)
        .sort((a, b) => a - b)
        .find(carriesAll);
    if (version === undefined) {
        throw new Error(
            `no transaction-extension pipeline carries every one of ${supplied.join(", ")}`,
        );
    }
    return version;
}

/**
 * The payload extensions the chosen pipeline declares, in its order.
 *
 * The PAPI enhancers fill every extension any pipeline declares, so a two-pipeline
 * chain such as People runtime 3004000 hands over slots the chosen version does
 * not carry. `VerifyMultiSignature` stays out unless the payload set it, because
 * the host signs into that slot itself.
 */
function pipelineExtensions(
    payload: TxPayloadV1,
    declared: ReadonlyArray<{ identifier: string }>,
): HostTxExtension[] {
    // First occurrence wins, as in the PAPI creators, so a custom extension
    // appended after one the outer wrapper already wrote cannot replace it.
    const supplied = new Map<string, TxPayloadV1["extensions"][number]>();
    for (const extension of payload.extensions) {
        if (!supplied.has(extension.id)) supplied.set(extension.id, extension);
    }
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
    const { fromHex, toHex } = await import("./truapi.js");
    const { Blake2256, compactNumber, extrinsicFormat, metadata } = await import(
        "@polkadot-api/substrate-bindings"
    );

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
    const filledOn = (version: number) =>
        pipelines[version]
            .filter(({ identifier }) => identifier !== "VerifyMultiSignature")
            .map(({ identifier }, index) => ({
                id: identifier,
                extra: toHex(new Uint8Array([index])),
                additionalSigned: "0x",
            }));
    const everyExtension = filledOn(1);
    const plainExtensions = filledOn(0);
    const payloadAt = (
        txExtVersion: number | null,
        extensions: TxPayloadV1["extensions"] = everyExtension,
        metadata = PEOPLE,
    ): TxPayloadV1 => ({
        version: 1,
        signer: null,
        callData: "0xca11",
        extensions,
        txExtVersion,
        context: {
            metadata,
            token: null,
            bestBlockHeight: 1,
            bestBlockHash: `0x${"11".repeat(32)}`,
            genesisHash: `0x${"22".repeat(32)}`,
        },
    });
    const noBindings = {} as Parameters<TxCreator>[2];

    // Asset Hub runtime 3004000: version 0 is the plain pipeline, version 1
    // adds AsPgas and the other origin extensions.
    const ASSET_HUB = toHex(
        new Uint8Array(
            readFileSync(
                new URL("../../descriptors/.papi/metadata/paseo_asset_hub.scale", import.meta.url),
            ),
        ),
    );
    const assetHubPlain = unifyMetadata(
        decAnyMetadata(ASSET_HUB),
    ).extrinsic.extensionsByVersion[0].map(({ identifier }, index) => ({
        id: identifier,
        extra: toHex(new Uint8Array([index])),
        additionalSigned: "0x",
    }));
    const asPgas = { id: "AsPgas", extra: "0x01ab", additionalSigned: "0x" };

    function hostSpy(preferredTxExtVersion?: number) {
        const requests: HostTxRequest[] = [];
        const creator = createHostTxCreator(
            new Uint8Array(32).fill(0xaa),
            async (request) => {
                requests.push(request);
                return "0xdead";
            },
            async () => new Uint8Array(64),
            preferredTxExtVersion,
        );
        return { creator, requests };
    }

    describe("createHostTxCreator", () => {
        test("a plain transaction signs on pipeline version 0 with only its extensions", async () => {
            const { creator, requests } = hostSpy();
            await creator(payloadAt(null, plainExtensions), {}, noBindings, false);
            expect(requests[0].txExtVersion).toBe(0);
            expect(requests[0].extensions.map(({ id }) => id)).toEqual(
                pipelines[0].map(({ identifier }) => identifier),
            );
        });

        test("an extension only version 1 declares lifts the transaction to version 1", async () => {
            const { creator, requests } = hostSpy();
            await creator(
                payloadAt(null, [...assetHubPlain, asPgas], ASSET_HUB),
                {},
                noBindings,
                false,
            );
            expect(requests[0].txExtVersion).toBe(1);
            expect(requests[0].extensions).toContainEqual(asPgas);
        });

        test("an extension passed as PAPI customSignedExtensions counts as supplied", async () => {
            const { creator, requests } = hostSpy();
            await creator(
                payloadAt(null, assetHubPlain, ASSET_HUB),
                { customSignedExtensions: { AsPgas: { value: undefined } } } as never,
                noBindings,
                false,
            );
            expect(requests[0].txExtVersion).toBe(1);
            expect(requests[0].extensions.find(({ id }) => id === "AsPgas")?.extra).toBe("0x00");
        });

        test("slots the enhancers fill with a default do not lift the version", async () => {
            // The enhancers fill AsPgas with None, since its type is an Option,
            // so a choice made after them would always land on version 1.
            const { creator, requests } = hostSpy();
            await creator(payloadAt(null, assetHubPlain, ASSET_HUB), {}, noBindings, false);
            expect(requests[0].txExtVersion).toBe(0);
            expect(requests[0].extensions.map(({ id }) => id)).not.toContain("AsPgas");
        });

        test("the preferred version is kept when its pipeline carries every supplied extension", async () => {
            const { creator, requests } = hostSpy(1);
            await creator(payloadAt(null, plainExtensions), {}, noBindings, false);
            expect(requests[0].txExtVersion).toBe(1);
        });

        test("an extension no pipeline declares is refused before the host is asked", async () => {
            const { creator, requests } = hostSpy();
            const unknown = { id: "NotAnExtension", extra: "0x00", additionalSigned: "0x" };
            await expect(
                creator(payloadAt(null, [...plainExtensions, unknown]), {}, noBindings, false),
            ).rejects.toThrow(
                /no transaction-extension pipeline carries every one of .*NotAnExtension/,
            );
            expect(requests).toHaveLength(0);
        });

        test("a preferred version the chain does not declare is refused by number", async () => {
            const { creator, requests } = hostSpy(7);
            await expect(
                creator(payloadAt(null, plainExtensions), {}, noBindings, false),
            ).rejects.toThrow(/no transaction-extension pipeline version 7/);
            expect(requests).toHaveLength(0);
        });

        test("the version on the payload wins over the extensions supplied", async () => {
            const { creator, requests } = hostSpy();
            await creator(payloadAt(1, plainExtensions), {}, noBindings, false);
            expect(requests[0].txExtVersion).toBe(1);
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
            const estimate = await creator(
                payloadAt(null, plainExtensions),
                {},
                { hasher } as never,
                true,
            );
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

        test("a fee estimate on a version the chain does not declare is refused the same way", async () => {
            const { creator, requests } = hostSpy();
            await expect(creator(payloadAt(7), {}, noBindings, true)).rejects.toThrow(
                /no transaction-extension pipeline version 7/,
            );
            expect(requests).toHaveLength(0);
        });

        test("a fee estimate on pipeline version 1 is a general transaction built locally", async () => {
            const { creator, requests } = hostSpy();
            const hashed: Uint8Array[] = [];
            const hasher = (data: Uint8Array) => ({
                subscribe(observer: { next(value: Uint8Array): void; complete(): void }) {
                    hashed.push(data);
                    observer.next(Blake2256(data));
                    observer.complete();
                    return { unsubscribe() {} };
                },
            });
            const estimate = await creator(payloadAt(1), {}, { hasher } as never, true);
            expect(requests).toHaveLength(0);
            const bytes = fromHex(estimate);
            const body = bytes.slice(bytes.length - compactNumber.dec(bytes));
            expect(extrinsicFormat.dec(body)).toEqual({ version: 5, type: "general" });
            // The v5 creator hashes the extension version first.
            expect(hashed[0]?.[0]).toBe(1);
        });

        test("a fee estimate on a pipeline without VerifyMultiSignature is priced as a plain account transaction", async () => {
            const decoded = metadata.dec(PEOPLE);
            if (decoded.metadata.tag !== "v16") throw new Error("expected v16 metadata");
            const extrinsic = decoded.metadata.value.extrinsic;
            const verify = extrinsic.signedExtensions.findIndex(
                ({ identifier }) => identifier === "VerifyMultiSignature",
            );
            extrinsic.signedExtensionsByVersion = extrinsic.signedExtensionsByVersion.map(
                ([version, indices]) => [
                    version,
                    version === 1 ? indices.filter((index) => index !== verify) : indices,
                ],
            );
            const payload = payloadAt(1);
            const { creator, requests } = hostSpy();
            const estimate = await creator(
                {
                    ...payload,
                    context: { ...payload.context, metadata: toHex(metadata.enc(decoded)) },
                },
                {},
                noBindings,
                true,
            );
            expect(requests).toHaveLength(0);
            const bytes = fromHex(estimate);
            const body = bytes.slice(bytes.length - compactNumber.dec(bytes));
            expect(extrinsicFormat.dec(body)).toEqual({ version: 4, type: "signed" });
        });

        test("the first of two entries for one extension is the one the host signs", async () => {
            const { creator, requests } = hostSpy();
            const payload = payloadAt(null, plainExtensions);
            const nonce = payload.extensions.find(({ id }) => id === "CheckNonce");
            const later = { id: "CheckNonce", extra: "0xffff", additionalSigned: "0x" };
            await creator(
                { ...payload, extensions: [...payload.extensions, later] },
                {},
                noBindings,
                false,
            );
            expect(requests[0].extensions.find(({ id }) => id === "CheckNonce")).toEqual(nonce);
        });
    });
}
