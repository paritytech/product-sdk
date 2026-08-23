// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Host wallet accounts, backed by `truApi.account.*` and `truApi.signing.*`.
 *
 * `getAccountsProvider()` returns the full accounts surface — user identity
 * (`getUserId` / `requestLogin`), the user's existing wallet accounts
 * (`getLegacyAccounts`), app-scoped product accounts (`getProductAccount` /
 * `getProductAccountAlias`), Ring VRF proofs (`createRingVRFProof`), sr25519 VRF
 * signatures over a caller-supplied Merlin transcript (`signVrf`), connection
 * status, and PAPI `PolkadotSigner` factories for both product and legacy
 * accounts.
 *
 * The signer factories build a PAPI `PolkadotSigner` directly over
 * `truApi.signing.createTransaction` (product) /
 * `createTransactionWithLegacyAccount` (legacy) — `signTx` derives the
 * metadata-driven `txExtVersion` and maps the signed extensions to the host's
 * wire shape; `signBytes` calls `signing.signRaw(WithLegacyAccount)`. No PJS
 * bridge is involved, so opaque signed extensions (e.g. Paseo Next's `AsPgas`)
 * survive end-to-end.
 *
 * @module
 */

import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { ResultAsync } from "neverthrow";
import { AccountId, type PolkadotSigner } from "polkadot-api";

import type {
    ContextualAlias as WireAlias,
    HostAccountConnectionStatusSubscribeItem,
    HostAccountCreateProofResponse as WireRingVRFProof,
    HostRequestLoginResponse,
    LegacyAccount as WireLegacyAccount,
    ProductAccount as WireProductAccount,
    ProductAccountId,
    ProductProofContext,
    RegisteredRingVrfKey as WireRegisteredRingVrfKey,
    RingLocation,
    RingVrfKeyDisclosure,
    TrUApiClient,
    VersionedHostAccountCreateProofError,
    VersionedHostAccountGetAliasError,
    VersionedHostAccountGetError,
    VersionedHostAccountListRingVrfKeysError,
    VersionedHostAccountRegisterRingVrfKeyError,
    VersionedHostAccountRingVrfSignError,
    VersionedHostAccountSignVrfError,
    VersionedHostGetLegacyAccountsError,
    VersionedHostGetUserIdError,
    VersionedHostRequestLoginError,
    VrfSignature as WireVrfSignature,
    VrfTranscriptItem as WireVrfTranscriptItem,
    scale,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { fromHex, toHex, unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/**
 * Ring VRF request shapes, re-exported from `@parity/truapi`:
 * - `RingLocation` — where the ring lives (`{ chainId, junctions }`; junctions
 *   address the ring via `PalletInstance` / `CollectionId` steps).
 * - `ProductProofContext` — the product-scoped proof context
 *   (`{ productId, suffix }`), expanded by the host into the 32-byte context a
 *   proof or alias is bound to.
 * - `DerivationIndex` — the tagged selector `ProductProofContext.suffix`
 *   carries: `{ tag: "Index", value: number }` for a plain index, or
 *   `{ tag: "Raw", value: HexString }` for a raw 32-byte index.
 */
export type {
    DerivationIndex,
    ProductProofContext,
    RingLocation,
    RingVrfKeyDisclosure,
} from "@parity/truapi";

// The account/alias shapes come from `@parity/truapi`'s generated specs; we
// derive the SDK-facing views from them so the field inventory tracks the
// protocol automatically, and override only the fields the adapter re-encodes:
// byte fields decoded from `0x`-prefixed `HexString`s to `Uint8Array`s, and
// the tagged derivation-index selector kept as a plain `number` (wrapped back
// into `Index` at the wire boundary). Shapes re-exported verbatim (e.g.
// `ProductProofContext`) track the wire as-is. Same pattern as
// `@parity/product-sdk-statement-store`.

/**
 * One of the user's existing wallet accounts, surfaced through the host and
 * identified by its public key and an optional name. Contrast with
 * {@link ProductAccount}, which is also user-controlled but derived by the
 * host for a specific app rather than picked from the user's existing keys.
 *
 * Derived from `@parity/truapi`'s `LegacyAccount`, with `publicKey` decoded to bytes.
 */
export type HostAccount = Omit<WireLegacyAccount, "publicKey"> & {
    /** Raw public key bytes. */
    publicKey: Uint8Array;
};

/**
 * A product account — an app-scoped derived account managed by the host wallet.
 *
 * The host derives a unique keypair for each app (identified by `dotNsIdentifier`)
 * so apps get their own account that the user controls but is scoped to the app.
 *
 * Combines `@parity/truapi`'s `ProductAccountId` (the `{ dotNsIdentifier,
 * derivationIndex }` lookup key) with the `ProductAccount` payload, with
 * `publicKey` decoded to bytes and `derivationIndex` kept as the plain
 * numeric index (the adapter wraps it into the wire's tagged
 * {@link DerivationIndex} selector).
 */
export type ProductAccount = Omit<ProductAccountId, "derivationIndex"> &
    Omit<WireProductAccount, "publicKey"> & {
        /** Plain account index within the product subtree. */
        derivationIndex: number;
        /** Raw public key bytes. */
        publicKey: Uint8Array;
    };

/**
 * How callers address a product account: app identifier plus an optional index,
 * defaulting to 0. A {@link ProductAccount} satisfies this, so an account from
 * {@link AccountsProvider.getProductAccount} can be passed straight back in.
 */
export type ProductAccountLookup = Omit<ProductAccountId, "derivationIndex"> & {
    /** Plain account index within the product subtree. Defaults to 0. */
    derivationIndex?: number;
};

declare const ringVrfKeyHandleBrand: unique symbol;

/**
 * Opaque public name of a registered ring-VRF key.
 *
 * Handles come from {@link AccountsProvider.listRingVrfKeys}; product code
 * cannot construct one from a derivation index.
 */
export type RingVrfKeyHandle = {
    readonly [ringVrfKeyHandleBrand]: "RingVrfKeyHandle";
};

/** Ring-VRF member public key, decoded from the wire's hex string. */
export type RingVrfPublicKey = Uint8Array;

/** Registered key metadata returned by the host. */
export type RegisteredRingVrfKey = Omit<WireRegisteredRingVrfKey, "handle" | "publicKey"> & {
    /** Opaque handle to pass back for alias and proof requests. */
    handle: RingVrfKeyHandle;
    /** Present when public-key disclosure was granted. */
    publicKey?: RingVrfPublicKey;
};

function sameRingLocation(a: RingLocation, b: RingLocation): boolean {
    if (
        a.chainId.toLowerCase() !== b.chainId.toLowerCase() ||
        a.junctions.length !== b.junctions.length
    ) {
        return false;
    }
    return a.junctions.every((junction, index) => {
        const candidate = b.junctions[index];
        if (junction.tag === "PalletInstance") {
            return candidate.tag === "PalletInstance" && junction.value === candidate.value;
        }
        return (
            candidate.tag === "CollectionId" &&
            junction.value.toLowerCase() === candidate.value.toLowerCase()
        );
    });
}

/**
 * Select a registered key by its declared ring and return its opaque handle.
 *
 * Consumers must not hard-code another product's derivation index. Registry
 * order breaks ties when an owner declares multiple keys for the same ring.
 */
export function findRingVrfKeyHandle(
    keys: RegisteredRingVrfKey[],
    ring: RingLocation,
): RingVrfKeyHandle | undefined {
    return keys.find((key) => key.rings.some((candidate) => sameRingLocation(candidate, ring)))
        ?.handle;
}

/**
 * A contextual alias obtained from Ring VRF.
 *
 * Proves account membership in a ring without revealing which account.
 *
 * Derived from `@parity/truapi`'s `ContextualAlias`, with both fields decoded to bytes.
 */
export type ContextualAlias = { [K in keyof WireAlias]: Uint8Array };

/**
 * A Ring VRF proof plus the values needed to verify it downstream (e.g.
 * against a precompile): the alias it commits to, and the ring member index /
 * revision the proof was generated against.
 *
 * Derived from `@parity/truapi`'s `HostAccountCreateProofResponse`, with the
 * byte fields decoded.
 */
export type RingVRFProof = Omit<WireRingVRFProof, "proof" | "contextualAlias"> & {
    /** Raw ring VRF proof bytes. */
    proof: Uint8Array;
    /** Alias derived for the request's context. */
    contextualAlias: ContextualAlias;
};

/**
 * One `append_message(label, value)` call replayed against a VRF transcript.
 * Merlin labels are ASCII by convention: use `utf8ToBytes("round")`.
 *
 * Derived from `@parity/truapi`'s `VrfTranscriptItem`, decoded to bytes.
 */
export type VrfTranscriptItem = { [K in keyof WireVrfTranscriptItem]: Uint8Array };

/**
 * An sr25519 VRF signature: the pre-output and its DLEQ proof.
 *
 * Derived from `@parity/truapi`'s `VrfSignature`, decoded to bytes.
 */
export type VrfSignature = { [K in keyof WireVrfSignature]: Uint8Array };

/**
 * Accounts provider handle, backed by `truApi.account.*` / `truApi.signing.*`.
 * Surfaces the user's wallet accounts, app-scoped product accounts, Ring VRF,
 * user identity, connection status, and `PolkadotSigner` factories.
 *
 * Lookup methods return a neverthrow `ResultAsync` (use `.match(ok, err)`);
 * the signer factories return a synchronous PAPI `PolkadotSigner`. The `err`
 * channel carries truapi's canonical `CallErrorValue` envelope around the
 * per-call versioned domain error, exactly as the generated client returns it.
 */
export interface AccountsProvider {
    getUserId(): ResultAsync<
        { primaryUsername: string },
        scale.CallErrorValue<VersionedHostGetUserIdError>
    >;
    requestLogin(
        reason?: string,
    ): ResultAsync<HostRequestLoginResponse, scale.CallErrorValue<VersionedHostRequestLoginError>>;
    getProductAccount(
        dotNsIdentifier: string,
        derivationIndex?: number,
    ): ResultAsync<ProductAccount, scale.CallErrorValue<VersionedHostAccountGetError>>;
    /**
     * Register a ring-VRF key owned by the calling product.
     *
     * `index` is the plain derivation index within the product's ring-VRF
     * domain; the adapter wraps it into the wire's tagged selector.
     *
     * Registration returns the key's public key. Call {@link listRingVrfKeys}
     * afterward to obtain the opaque handle required by alias and proof calls.
     */
    registerRingVrfKey(
        index: number,
        ring: RingLocation,
    ): ResultAsync<
        RingVrfPublicKey,
        scale.CallErrorValue<VersionedHostAccountRegisterRingVrfKeyError>
    >;
    /** List an owner's registered ring-VRF keys. */
    listRingVrfKeys(
        owner: string,
        disclosure?: RingVrfKeyDisclosure,
    ): ResultAsync<
        RegisteredRingVrfKey[],
        scale.CallErrorValue<VersionedHostAccountListRingVrfKeysError>
    >;
    /** Derive a contextual alias with an explicitly registered ring-VRF key. */
    getProductAccountAlias(
        keyHandle: RingVrfKeyHandle,
        context: ProductProofContext,
        location: RingLocation,
    ): ResultAsync<ContextualAlias, scale.CallErrorValue<VersionedHostAccountGetAliasError>>;
    getLegacyAccounts(): ResultAsync<
        HostAccount[],
        scale.CallErrorValue<VersionedHostGetLegacyAccountsError>
    >;
    /**
     * Generate a Ring VRF proof with an explicitly registered key, binding
     * `message` to the product-scoped `context`.
     */
    createRingVRFProof(
        keyHandle: RingVrfKeyHandle,
        context: ProductProofContext,
        location: RingLocation,
        message: Uint8Array,
    ): ResultAsync<RingVRFProof, scale.CallErrorValue<VersionedHostAccountCreateProofError>>;
    /**
     * Sign `message` directly with an explicitly registered ring-VRF key.
     *
     * Unlike {@link createRingVRFProof} this proves nothing about ring
     * membership; it is the plain signature under the member key, for
     * protocols that carry their own proof.
     */
    ringVrfSign(
        keyHandle: RingVrfKeyHandle,
        message: Uint8Array,
    ): ResultAsync<Uint8Array, scale.CallErrorValue<VersionedHostAccountRingVrfSignError>>;
    /**
     * Produce an sr25519 VRF signature from a product account (RFC-0023).
     *
     * The host builds a Merlin transcript from `transcriptLabel` and `items`,
     * then signs it with the account's key. Unlike {@link createRingVRFProof},
     * this names the signing account instead of proving ring membership.
     *
     * The caller owns four things the types cannot enforce:
     *
     * - Domain separation. A label borrowed from another protocol makes the
     *   output replayable across both.
     * - Freshness. The VRF is deterministic, so per-round values belong in
     *   `items`.
     * - Size. Hosts cap the transcript at 32 items and 8 KiB total.
     * - Authorization. An `AutoSigning` allowance makes these calls silent. It
     *   is not VRF-scoped, so it covers other signing by that account too.
     *
     * Hosts predating the call reject it through the error channel.
     */
    signVrf(
        account: ProductAccountLookup,
        transcriptLabel: Uint8Array,
        items: VrfTranscriptItem[],
    ): ResultAsync<VrfSignature, scale.CallErrorValue<VersionedHostAccountSignVrfError>>;
    /**
     * Build a `PolkadotSigner` for a product account. Signing routes through the
     * host's `createTransaction` path: the host decodes the metadata and forwards
     * the opaque signed-extension bytes, so unknown extensions survive end-to-end.
     */
    getProductAccountSigner(account: ProductAccount): PolkadotSigner;
    /**
     * Build a `PolkadotSigner` for one of the user's existing wallet accounts.
     * `name` is accepted for callsite ergonomics but unused — the signer is
     * derived from `publicKey` alone.
     */
    getLegacyAccountSigner(account: { publicKey: Uint8Array; name?: string }): PolkadotSigner;
    subscribeAccountConnectionStatus(
        callback: (status: HostAccountConnectionStatusSubscribeItem) => void,
    ): HostSubscription;
}

/**
 * Map metadata's supported extrinsic formats to the host wire protocol.
 *
 * V4 carries the account signature in its envelope. V5 General transactions
 * delegate authorization to the runtime's extension pipeline, but metadata
 * alone does not say whether the connected host can implement that pipeline.
 * Prefer an advertised V4 until the host protocol can negotiate V5
 * authorization capabilities; V5-only and unknown future runtimes retain the
 * previous highest-version behavior and the host remains authoritative.
 */
function selectHostTxExtVersion(versions: readonly number[]): number {
    if (versions.length === 0) {
        throw new Error("No extrinsic version found in metadata");
    }
    if (versions.includes(4)) {
        return 0;
    }
    return versions.reduce((acc, version) => Math.max(acc, version), 0);
}

/** Derive the host's transaction-extension version from SCALE metadata. */
function deriveTxExtVersion(metadata: Uint8Array): number {
    const versions = unifyMetadata(decAnyMetadata(metadata)).extrinsic.version;
    return selectHostTxExtVersion(versions);
}

/** Internal seam so `import.meta.vitest` can stub the metadata decode. @internal */
const deps = { deriveTxExtVersion };

/**
 * Map a PAPI `signTx` call's signed extensions onto the host's
 * `TxPayloadExtension` wire shape (hex-encoded `extra` / `additionalSigned`).
 */
function toHostExtensions(
    signedExtensions: Record<
        string,
        { identifier: string; value: Uint8Array; additionalSigned: Uint8Array }
    >,
) {
    return Object.values(signedExtensions).map((ext) => ({
        id: ext.identifier,
        extra: toHex(ext.value),
        additionalSigned: toHex(ext.additionalSigned),
    }));
}

/**
 * Build the wire `ProductAccountId`: default the index to 0, wrap it as `Index`.
 *
 * Destructured rather than spread, so passing a full {@link ProductAccount}
 * cannot leak its `publicKey` onto the wire.
 */
function toWireProductAccountId({
    dotNsIdentifier,
    derivationIndex = 0,
}: ProductAccountLookup): ProductAccountId {
    return { dotNsIdentifier, derivationIndex: { tag: "Index", value: derivationIndex } };
}

/** Build an {@link AccountsProvider} over a TruAPI client's `account` / `signing` domains. */
function adaptAccountsProvider(client: TrUApiClient): AccountsProvider {
    const account = client.account;
    const signing = client.signing;

    return {
        getUserId() {
            return account.getUserId().map((response) => ({
                primaryUsername: response.primaryUsername,
            }));
        },
        requestLogin(reason) {
            return account.requestLogin({ reason });
        },
        getProductAccount(dotNsIdentifier, derivationIndex = 0) {
            return account
                .getAccount({
                    productAccountId: toWireProductAccountId({ dotNsIdentifier, derivationIndex }),
                })
                .map((response) => ({
                    publicKey: fromHex(response.account.publicKey),
                    dotNsIdentifier,
                    derivationIndex,
                }));
        },
        registerRingVrfKey(index, ring) {
            return account
                .registerRingVrfKey({ index: { tag: "Index", value: index }, ring })
                .map(fromHex);
        },
        listRingVrfKeys(owner, disclosure = "Anonymized") {
            return account.listRingVrfKeys({ owner, disclosure }).map((keys) =>
                keys.map((key) => ({
                    ...key,
                    handle: key.handle as unknown as RingVrfKeyHandle,
                    publicKey: key.publicKey === undefined ? undefined : fromHex(key.publicKey),
                })),
            );
        },
        getProductAccountAlias(keyHandle, context, location) {
            return account
                .getAccountAlias({
                    keyHandle: keyHandle as unknown as ProductAccountId,
                    context,
                    ringLocation: location,
                })
                .map((response) => ({
                    context: fromHex(response.context),
                    alias: fromHex(response.alias),
                }));
        },
        getLegacyAccounts() {
            return account.getLegacyAccounts().map((response) =>
                response.accounts.map((a) => ({
                    publicKey: fromHex(a.publicKey),
                    name: a.name,
                })),
            );
        },
        createRingVRFProof(keyHandle, context, location, message) {
            return account
                .createAccountProof({
                    keyHandle: keyHandle as unknown as ProductAccountId,
                    context,
                    ringLocation: location,
                    message: toHex(message),
                })
                .map((response) => ({
                    proof: fromHex(response.proof),
                    contextualAlias: {
                        context: fromHex(response.contextualAlias.context),
                        alias: fromHex(response.contextualAlias.alias),
                    },
                    ringIndex: response.ringIndex,
                    ringRevision: response.ringRevision,
                }));
        },
        ringVrfSign(keyHandle, message) {
            return account
                .ringVrfSign({
                    keyHandle: keyHandle as unknown as ProductAccountId,
                    message: toHex(message),
                })
                .map(fromHex);
        },
        signVrf(account_, transcriptLabel, items) {
            return account
                .signVrf({
                    account: toWireProductAccountId(account_),
                    transcriptLabel: toHex(transcriptLabel),
                    items: items.map(({ label, value }) => ({
                        label: toHex(label),
                        value: toHex(value),
                    })),
                })
                .map((response) => ({
                    preOutput: fromHex(response.preOutput),
                    proof: fromHex(response.proof),
                }));
        },
        getProductAccountSigner(account_) {
            const productAccountId = toWireProductAccountId(account_);

            return {
                publicKey: account_.publicKey,
                async signTx(callData, signedExtensions, metadata) {
                    const checkGenesis = signedExtensions.CheckGenesis;
                    if (!checkGenesis) {
                        throw new Error("Can't find genesis hash on transaction");
                    }

                    const response = await unwrapHostResult(
                        signing.createTransaction({
                            signer: productAccountId,
                            genesisHash: toHex(checkGenesis.additionalSigned),
                            callData: toHex(callData),
                            extensions: toHostExtensions(signedExtensions),
                            txExtVersion: deps.deriveTxExtVersion(metadata),
                        }),
                        "createTransaction failed",
                    );
                    return fromHex(response.transaction);
                },
                async signBytes(data) {
                    const response = await unwrapHostResult(
                        signing.signRaw({
                            account: productAccountId,
                            payload: { tag: "Bytes", value: { bytes: toHex(data) } },
                        }),
                        "signRaw failed",
                    );
                    return fromHex(response.signature);
                },
            };
        },
        getLegacyAccountSigner(account_) {
            // `createTransactionWithLegacyAccount` identifies the signer by its
            // raw account id (hex public key); `signRawWithLegacyAccount` takes an
            // SS58 address the wallet can match. Compute both up front.
            const signerHex = toHex(account_.publicKey);
            const ss58Address = AccountId().dec(account_.publicKey);

            return {
                publicKey: account_.publicKey,
                async signTx(callData, signedExtensions, metadata) {
                    const checkGenesis = signedExtensions.CheckGenesis;
                    if (!checkGenesis) {
                        throw new Error("Can't find genesis hash on transaction");
                    }

                    const response = await unwrapHostResult(
                        signing.createTransactionWithLegacyAccount({
                            signer: signerHex,
                            genesisHash: toHex(checkGenesis.additionalSigned),
                            callData: toHex(callData),
                            extensions: toHostExtensions(signedExtensions),
                            txExtVersion: deps.deriveTxExtVersion(metadata),
                        }),
                        "createTransactionWithLegacyAccount failed",
                    );
                    return fromHex(response.transaction);
                },
                async signBytes(data) {
                    const response = await unwrapHostResult(
                        signing.signRawWithLegacyAccount({
                            signer: ss58Address,
                            payload: { tag: "Bytes", value: { bytes: toHex(data) } },
                        }),
                        "signRawWithLegacyAccount failed",
                    );
                    return fromHex(response.signature);
                },
            };
        },
        subscribeAccountConnectionStatus(callback) {
            return subscribeWithInterrupt(account.connectionStatusSubscribe(), callback);
        },
    };
}

/**
 * Get the accounts provider for managing host accounts, backed by
 * `truApi.account.*` / `truApi.signing.*`. Returns `null` when running outside
 * a host container.
 *
 * @returns The accounts provider, or `null` if unavailable.
 */
export async function getAccountsProvider(): Promise<AccountsProvider | null> {
    const client = await getClient();
    return client ? adaptAccountsProvider(client) : null;
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;

    test("host signing prefers V4 on a dual V4/V5 runtime", () => {
        expect(selectHostTxExtVersion([4, 5])).toBe(0);
    });

    test("host signing uses V5 when V4 is unavailable", () => {
        expect(selectHostTxExtVersion([5])).toBe(5);
    });

    test("host signing maps a V4-only runtime to the wire sentinel", () => {
        expect(selectHostTxExtVersion([4])).toBe(0);
    });

    test("host signing rejects metadata with no extrinsic version", () => {
        expect(() => selectHostTxExtVersion([])).toThrow("No extrinsic version found in metadata");
    });

    /** Minimal fake of the truapi account/signing domains used to test the adapter. */
    function makeFakeClient(opts: { onCall?: (method: string, args: unknown) => void } = {}) {
        const okMatch = (value: unknown) => ({
            // neverthrow ResultAsync surface used by the adapter: .map + .match.
            map: (fn: (v: unknown) => unknown) => okMatch(fn(value)),
            match: (ok: (v: unknown) => unknown, _err: (e: unknown) => unknown) => ok(value),
        });
        const method = (name: string, response: unknown) => (args: unknown) => {
            opts.onCall?.(name, args);
            return okMatch(response);
        };
        return {
            account: {
                getUserId: method("getUserId", { primaryUsername: "alice.dot" }),
                getAccount: method("getAccount", { account: { publicKey: "0xaa" } }),
                registerRingVrfKey: method("registerRingVrfKey", "0x0304"),
                ringVrfSign: method("ringVrfSign", "0xba5eba11"),
                listRingVrfKeys: method("listRingVrfKeys", [
                    {
                        handle: {
                            dotNsIdentifier: "people.dot",
                            derivationIndex: { tag: "Index", value: 0 },
                        },
                        rings: [
                            {
                                chainId: "0x01",
                                junctions: [{ tag: "PalletInstance", value: 1 }],
                            },
                        ],
                    },
                    {
                        handle: {
                            dotNsIdentifier: "people.dot",
                            derivationIndex: { tag: "Index", value: 1 },
                        },
                        rings: [
                            {
                                chainId: "0x02",
                                junctions: [{ tag: "CollectionId", value: "0xaabb" }],
                            },
                        ],
                        publicKey: "0x0102",
                    },
                ]),
                getAccountAlias: method("getAccountAlias", { context: "0x01", alias: "0x02" }),
                getLegacyAccounts: method("getLegacyAccounts", {
                    accounts: [{ publicKey: "0xbb", name: "Bob" }],
                }),
                createAccountProof: method("createAccountProof", {
                    proof: "0xc0ffee",
                    contextualAlias: { context: "0x01", alias: "0x02" },
                    ringIndex: 3,
                    ringRevision: 7,
                }),
                signVrf: method("signVrf", { preOutput: "0xaa11", proof: "0xbb22" }),
                connectionStatusSubscribe: () => ({
                    subscribe: () => ({ unsubscribe: vi.fn() }),
                    [Symbol.observable as symbol]() {
                        return this;
                    },
                }),
            },
            signing: {
                createTransaction: method("createTransaction", { transaction: "0xdead" }),
                createTransactionWithLegacyAccount: method("createTransactionWithLegacyAccount", {
                    transaction: "0xfeed",
                }),
                signRaw: method("signRaw", { signature: "0xbeef" }),
                signRawWithLegacyAccount: method("signRawWithLegacyAccount", {
                    signature: "0xcafe",
                }),
            },
        } as unknown as TrUApiClient;
    }

    test("getAccountsProvider returns null outside a container", async () => {
        expect(await getAccountsProvider()).toBeNull();
    });

    test("getProductAccount decodes the public key and carries the identifier", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const account = await provider.getProductAccount("app.dot", 2).match(
            (a) => a,
            () => null,
        );
        expect(calls[0]).toEqual([
            "getAccount",
            {
                productAccountId: {
                    dotNsIdentifier: "app.dot",
                    derivationIndex: { tag: "Index", value: 2 },
                },
            },
        ]);
        expect(account).toEqual({
            publicKey: fromHex("0xaa"),
            dotNsIdentifier: "app.dot",
            derivationIndex: 2,
        });
    });

    test("getProductAccount defaults the derivation index in both the request and the result", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const account = await provider.getProductAccount("app.dot").match(
            (a) => a,
            () => null,
        );
        expect(calls[0]).toEqual([
            "getAccount",
            {
                productAccountId: {
                    dotNsIdentifier: "app.dot",
                    derivationIndex: { tag: "Index", value: 0 },
                },
            },
        ]);
        // The resolved index must reach the caller too, not just the wire.
        expect(account?.derivationIndex).toBe(0);
    });

    test("registerRingVrfKey wraps the numeric index and decodes the public key", async () => {
        const calls: Array<[string, unknown]> = [];
        const provider = adaptAccountsProvider(
            makeFakeClient({ onCall: (method, args) => calls.push([method, args]) }),
        );
        const ring: RingLocation = {
            chainId: "0x01",
            junctions: [{ tag: "PalletInstance", value: 67 }],
        };
        const index = 2;
        const publicKey = await provider.registerRingVrfKey(index, ring).match(
            (value) => value,
            () => null,
        );

        expect(calls[0]).toEqual([
            "registerRingVrfKey",
            { index: { tag: "Index", value: 2 }, ring },
        ]);
        expect(publicKey).toEqual(fromHex("0x0304"));
    });

    test("listRingVrfKeys selects by ring without exposing a raw index", async () => {
        const calls: Array<[string, unknown]> = [];
        const provider = adaptAccountsProvider(
            makeFakeClient({ onCall: (method, args) => calls.push([method, args]) }),
        );
        const keys = await provider.listRingVrfKeys("people.dot", "PublicKey").match(
            (value) => value,
            () => [],
        );
        expect(calls[0]).toEqual([
            "listRingVrfKeys",
            { owner: "people.dot", disclosure: "PublicKey" },
        ]);
        expect(keys[1].publicKey).toEqual(fromHex("0x0102"));
        expect(
            findRingVrfKeyHandle(keys, {
                chainId: "0x02",
                junctions: [{ tag: "CollectionId", value: "0xAABB" }],
            }),
        ).toEqual(keys[1].handle);
    });

    test("getProductAccountAlias passes the selected key handle", async () => {
        const calls: Array<[string, unknown]> = [];
        const provider = adaptAccountsProvider(
            makeFakeClient({ onCall: (method, args) => calls.push([method, args]) }),
        );
        const keys = await provider.listRingVrfKeys("people.dot").match(
            (value) => value,
            () => [],
        );
        calls.length = 0;
        const keyHandle = keys[1].handle;
        const context: ProductProofContext = {
            productId: "app.dot",
            suffix: { tag: "Index", value: 0 },
        };
        const ring: RingLocation = {
            chainId: "0x01",
            junctions: [{ tag: "PalletInstance", value: 1 }],
        };
        const alias = await provider.getProductAccountAlias(keyHandle, context, ring).match(
            (value) => value,
            () => null,
        );
        expect(calls[0]).toEqual(["getAccountAlias", { keyHandle, context, ringLocation: ring }]);
        expect(alias).toEqual({ context: fromHex("0x01"), alias: fromHex("0x02") });
    });

    test("ringVrfSign passes the selected handle and decodes the signature", async () => {
        const calls: Array<[string, unknown]> = [];
        const provider = adaptAccountsProvider(
            makeFakeClient({ onCall: (method, args) => calls.push([method, args]) }),
        );
        const keys = await provider.listRingVrfKeys("people.dot").match(
            (value) => value,
            () => [],
        );
        calls.length = 0;
        const keyHandle = keys[1].handle;
        const signature = await provider.ringVrfSign(keyHandle, new Uint8Array([1, 2, 3])).match(
            (value) => value,
            () => null,
        );
        expect(calls[0]).toEqual([
            "ringVrfSign",
            { keyHandle, message: toHex(new Uint8Array([1, 2, 3])) },
        ]);
        expect(signature).toEqual(fromHex("0xba5eba11"));
    });

    test("createRingVRFProof hex-encodes the message and decodes the proof response", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const keyHandle = (
            await provider.listRingVrfKeys("people.dot").match(
                (value) => value,
                () => [],
            )
        )[0].handle;
        calls.length = 0;
        const proof = await provider
            .createRingVRFProof(
                keyHandle,
                { productId: "app.dot", suffix: { tag: "Index", value: 0 } },
                { chainId: "0x01", junctions: [{ tag: "PalletInstance", value: 1 }] },
                new Uint8Array([1, 2, 3]),
            )
            .match(
                (p) => p,
                () => null,
            );
        expect(calls[0][0]).toBe("createAccountProof");
        expect(calls[0][1]).toEqual({
            keyHandle: {
                dotNsIdentifier: "people.dot",
                derivationIndex: { tag: "Index", value: 0 },
            },
            context: { productId: "app.dot", suffix: { tag: "Index", value: 0 } },
            ringLocation: { chainId: "0x01", junctions: [{ tag: "PalletInstance", value: 1 }] },
            message: toHex(new Uint8Array([1, 2, 3])),
        });
        expect(proof).toEqual({
            proof: fromHex("0xc0ffee"),
            contextualAlias: { context: fromHex("0x01"), alias: fromHex("0x02") },
            ringIndex: 3,
            ringRevision: 7,
        });
    });

    test("signVrf hex-encodes the transcript and decodes the signature", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const transcriptLabel = new Uint8Array([1, 2, 3]);
        const itemLabel = new Uint8Array([4]);
        const itemValue = new Uint8Array([5, 6]);
        const signature = await provider
            .signVrf({ dotNsIdentifier: "app.dot", derivationIndex: 3 }, transcriptLabel, [
                { label: itemLabel, value: itemValue },
            ])
            .match(
                (s) => s,
                () => null,
            );
        expect(calls[0]).toEqual([
            "signVrf",
            {
                account: {
                    dotNsIdentifier: "app.dot",
                    derivationIndex: { tag: "Index", value: 3 },
                },
                transcriptLabel: toHex(transcriptLabel),
                items: [{ label: toHex(itemLabel), value: toHex(itemValue) }],
            },
        ]);
        expect(signature).toEqual({ preOutput: fromHex("0xaa11"), proof: fromHex("0xbb22") });
    });

    test("signVrf defaults the derivation index", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        await provider.signVrf({ dotNsIdentifier: "app.dot" }, new Uint8Array([1]), []).match(
            (s) => s,
            () => null,
        );
        expect((calls[0][1] as { account: unknown }).account).toEqual({
            dotNsIdentifier: "app.dot",
            derivationIndex: { tag: "Index", value: 0 },
        });
    });

    test("signVrf sends only the id fields when given a full product account", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const account: ProductAccount = {
            dotNsIdentifier: "app.dot",
            derivationIndex: 1,
            publicKey: new Uint8Array(32).fill(0xaa),
        };
        await provider.signVrf(account, new Uint8Array([1]), []).match(
            (s) => s,
            () => null,
        );
        expect(Object.keys((calls[0][1] as { account: object }).account)).toEqual([
            "dotNsIdentifier",
            "derivationIndex",
        ]);
    });

    test("the product signer signs bytes via signing.signRaw", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const signer = provider.getProductAccountSigner({
            dotNsIdentifier: "app.dot",
            derivationIndex: 0,
            publicKey: new Uint8Array(32).fill(0xaa),
        });
        const signature = await signer.signBytes(new Uint8Array([9, 9]));
        expect(calls.at(-1)).toEqual([
            "signRaw",
            {
                account: {
                    dotNsIdentifier: "app.dot",
                    derivationIndex: { tag: "Index", value: 0 },
                },
                payload: { tag: "Bytes", value: { bytes: toHex(new Uint8Array([9, 9])) } },
            },
        ]);
        expect(signature).toEqual(fromHex("0xbeef"));
    });

    test("the legacy signer signs bytes via signing.signRawWithLegacyAccount (by SS58 address)", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const publicKey = new Uint8Array(32).fill(0xbb);
        const signer = provider.getLegacyAccountSigner({ publicKey });
        const signature = await signer.signBytes(new Uint8Array([7, 7]));
        // signRawWithLegacyAccount identifies the signer by SS58 address, not raw pubkey.
        expect(calls.at(-1)).toEqual([
            "signRawWithLegacyAccount",
            {
                signer: AccountId().dec(publicKey),
                payload: { tag: "Bytes", value: { bytes: toHex(new Uint8Array([7, 7])) } },
            },
        ]);
        expect(signature).toEqual(fromHex("0xcafe"));
    });

    test("the legacy signer's signTx throws without a CheckGenesis extension", async () => {
        const provider = adaptAccountsProvider(makeFakeClient());
        const signer = provider.getLegacyAccountSigner({
            publicKey: new Uint8Array(32).fill(0xbb),
        });
        await expect(signer.signTx(new Uint8Array([1]), {}, new Uint8Array(), 0)).rejects.toThrow(
            "Can't find genesis hash on transaction",
        );
    });

    // Signed extensions PAPI hands to `signTx`. `CheckGenesis.additionalSigned`
    // carries the genesis hash the signer pulls out; the rest are mapped to the
    // host's `{ id, extra, additionalSigned }` wire shape.
    const sampleExtensions = {
        CheckGenesis: {
            identifier: "CheckGenesis",
            value: new Uint8Array([]),
            additionalSigned: new Uint8Array([0x01, 0x02]),
        },
        CheckNonce: {
            identifier: "CheckNonce",
            value: new Uint8Array([0x05]),
            additionalSigned: new Uint8Array([]),
        },
    };
    const expectedHostExtensions = [
        {
            id: "CheckGenesis",
            extra: toHex(new Uint8Array([])),
            additionalSigned: toHex(new Uint8Array([0x01, 0x02])),
        },
        {
            id: "CheckNonce",
            extra: toHex(new Uint8Array([0x05])),
            additionalSigned: toHex(new Uint8Array([])),
        },
    ];

    test("the product signer's signTx builds createTransaction from genesis + extensions", async () => {
        // Stub the metadata decode (needs a real SCALE blob) so the rest of the
        // signTx flow — genesis extraction, extension mapping, the host call,
        // response decode — is exercised against a fixed txExtVersion.
        vi.spyOn(deps, "deriveTxExtVersion").mockReturnValue(0);
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const signer = provider.getProductAccountSigner({
            dotNsIdentifier: "app.dot",
            derivationIndex: 0,
            publicKey: new Uint8Array(32).fill(0xaa),
        });

        const signed = await signer.signTx(
            new Uint8Array([0xca, 0x11]),
            sampleExtensions,
            new Uint8Array([0x6d]),
            0,
        );

        expect(calls.at(-1)).toEqual([
            "createTransaction",
            {
                signer: { dotNsIdentifier: "app.dot", derivationIndex: { tag: "Index", value: 0 } },
                genesisHash: toHex(new Uint8Array([0x01, 0x02])),
                callData: toHex(new Uint8Array([0xca, 0x11])),
                extensions: expectedHostExtensions,
                txExtVersion: 0,
            },
        ]);
        expect(signed).toEqual(fromHex("0xdead"));
        vi.restoreAllMocks();
    });

    test("the legacy signer's signTx builds createTransactionWithLegacyAccount (signer = hex pubkey)", async () => {
        vi.spyOn(deps, "deriveTxExtVersion").mockReturnValue(0);
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const publicKey = new Uint8Array(32).fill(0xbb);
        const signer = provider.getLegacyAccountSigner({ publicKey });

        const signed = await signer.signTx(
            new Uint8Array([0xca, 0x11]),
            sampleExtensions,
            new Uint8Array([0x6d]),
            0,
        );

        expect(calls.at(-1)).toEqual([
            "createTransactionWithLegacyAccount",
            {
                // createTransactionWithLegacyAccount identifies the signer by raw hex pubkey.
                signer: toHex(publicKey),
                genesisHash: toHex(new Uint8Array([0x01, 0x02])),
                callData: toHex(new Uint8Array([0xca, 0x11])),
                extensions: expectedHostExtensions,
                txExtVersion: 0,
            },
        ]);
        expect(signed).toEqual(fromHex("0xfeed"));
        vi.restoreAllMocks();
    });
}
