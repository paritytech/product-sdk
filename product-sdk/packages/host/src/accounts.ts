// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Host wallet accounts, backed by `truApi.account.*` and `truApi.signing.*`.
 *
 * `getAccountsProvider()` returns the full accounts surface — user identity
 * (`getUserId` / `requestLogin`), the user's existing wallet accounts
 * (`getLegacyAccounts`), app-scoped product accounts (`getProductAccount` /
 * `getProductAccountAlias`), Ring VRF key registration (`registerRingVrfKey` /
 * `listRingVrfKeys`) and proofs/signing (`createRingVRFProof` / `ringVrfSign`)
 * over explicitly registered keys, sr25519 VRF signatures over a
 * caller-supplied Merlin transcript (`signVrf`), connection status, and PAPI
 * `PolkadotSigner` factories for both product and legacy accounts.
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
    DerivationIndex,
    HostAccountConnectionStatusSubscribeItem,
    HostAccountCreateProofResponse as WireRingVRFProof,
    HostRequestLoginResponse,
    LegacyAccount as WireLegacyAccount,
    ProductAccount as WireProductAccount,
    ProductAccountId,
    ProductProofContext,
    RegisteredRingVrfKey,
    RingLocation,
    RingVrfKeyDisclosure,
    RingVrfPublicKey,
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
 * - `RingVrfPublicKey` — a ring-VRF member public key (`HexString`).
 * - `RegisteredRingVrfKey` — a registry entry (`{ handle, rings, publicKey? }`).
 *   `publicKey` is present only when the caller owns the key or disclosure
 *   was granted.
 * - `RingVrfKeyDisclosure` — how much of a registry entry `listRingVrfKeys`
 *   asks for (`"Anonymized" | "PublicKey"`).
 */
export type {
    DerivationIndex,
    ProductProofContext,
    RegisteredRingVrfKey,
    RingLocation,
    RingVrfKeyDisclosure,
    RingVrfPublicKey,
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
     * Derive the contextual alias for a proof context and ring. Uses the
     * registered key named by `keyHandle` (see {@link registerRingVrfKey}).
     */
    getProductAccountAlias(
        keyHandle: ProductAccountId,
        context: ProductProofContext,
        location: RingLocation,
    ): ResultAsync<ContextualAlias, scale.CallErrorValue<VersionedHostAccountGetAliasError>>;
    getLegacyAccounts(): ResultAsync<
        HostAccount[],
        scale.CallErrorValue<VersionedHostGetLegacyAccountsError>
    >;
    /**
     * Generate a Ring VRF proof binding `message` to the product-scoped
     * `context`. Uses the registered key named by `keyHandle` (see
     * {@link registerRingVrfKey}). The result carries the proof plus its
     * verification values ({@link RingVRFProof}).
     */
    createRingVRFProof(
        keyHandle: ProductAccountId,
        context: ProductProofContext,
        location: RingLocation,
        message: Uint8Array,
    ): ResultAsync<RingVRFProof, scale.CallErrorValue<VersionedHostAccountCreateProofError>>;
    /**
     * Register a ring-VRF key owned by the calling product at `index` within
     * its ring-VRF domain, declared for `ring`. Returns the member's public
     * key. The registered key is then addressed by a `keyHandle` of
     * `{ dotNsIdentifier: <calling product>, derivationIndex: index }`.
     */
    registerRingVrfKey(
        index: DerivationIndex,
        ring: RingLocation,
    ): ResultAsync<
        RingVrfPublicKey,
        scale.CallErrorValue<VersionedHostAccountRegisterRingVrfKeyError>
    >;
    /**
     * List ring-VRF keys registered by `owner` (a dotNS product identifier).
     * `disclosure` controls whether entries carry their public key.
     */
    listRingVrfKeys(
        owner: string,
        disclosure: RingVrfKeyDisclosure,
    ): ResultAsync<
        RegisteredRingVrfKey[],
        scale.CallErrorValue<VersionedHostAccountListRingVrfKeysError>
    >;
    /**
     * Sign `message` directly with the registered ring-VRF key named by
     * `keyHandle`.
     */
    ringVrfSign(
        keyHandle: ProductAccountId,
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
 * Derive the host's extrinsic-extension version from SCALE-encoded metadata:
 * v4 → 0, otherwise the latest supported version. `unifyMetadata` normalizes
 * v14/v15 so `.extrinsic.version` is an array.
 *
 * Indirected through {@link deps} so the SCALE decode (which needs a real
 * metadata blob) can be stubbed in unit tests while the rest of the `signTx`
 * flow — genesis extraction, extension mapping, the host call — is exercised.
 */
function deriveTxExtVersion(metadata: Uint8Array): number {
    const versions = unifyMetadata(decAnyMetadata(metadata)).extrinsic.version;
    if (versions.length === 0) {
        throw new Error("No extrinsic version found in metadata");
    }
    const latestVersion = versions.reduce((acc, v) => Math.max(acc, v), 0);
    return latestVersion === 4 ? 0 : latestVersion;
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
        getProductAccountAlias(keyHandle, context, location) {
            return account
                .getAccountAlias({ keyHandle, context, ringLocation: location })
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
                    keyHandle,
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
        registerRingVrfKey(index, ring) {
            return account.registerRingVrfKey({ index, ring });
        },
        listRingVrfKeys(owner, disclosure) {
            return account.listRingVrfKeys({ owner, disclosure });
        },
        ringVrfSign(keyHandle, message) {
            return account.ringVrfSign({ keyHandle, message: toHex(message) }).map(fromHex);
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
                registerRingVrfKey: method("registerRingVrfKey", "0xf00d"),
                listRingVrfKeys: method("listRingVrfKeys", [
                    {
                        handle: {
                            dotNsIdentifier: "app.dot",
                            derivationIndex: { tag: "Index", value: 0 },
                        },
                        rings: [{ chainId: "0x01", junctions: [] }],
                        publicKey: "0xf00d",
                    },
                ]),
                ringVrfSign: method("ringVrfSign", "0xba5eba11"),
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

    // Handle naming the ring-VRF member key, shared by the createRingVRFProof
    // and ringVrfSign tests below.
    const sampleKeyHandle = {
        dotNsIdentifier: "app.dot",
        derivationIndex: { tag: "Index" as const, value: 0 },
    };

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

    test("createRingVRFProof passes the keyHandle through, hex-encodes the message, and decodes the proof response", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const proof = await provider
            .createRingVRFProof(
                sampleKeyHandle,
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
            keyHandle: sampleKeyHandle,
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

    test("registerRingVrfKey passes index/ring through and returns the wire public key", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const publicKey = await provider
            .registerRingVrfKey(
                { tag: "Index", value: 0 },
                { chainId: "0x01", junctions: [{ tag: "PalletInstance", value: 1 }] },
            )
            .match(
                (pk) => pk,
                () => null,
            );
        expect(calls[0]).toEqual([
            "registerRingVrfKey",
            {
                index: { tag: "Index", value: 0 },
                ring: { chainId: "0x01", junctions: [{ tag: "PalletInstance", value: 1 }] },
            },
        ]);
        expect(publicKey).toBe("0xf00d");
    });

    test("listRingVrfKeys passes owner/disclosure through and returns the wire entries", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const entries = await provider.listRingVrfKeys("app.dot", "PublicKey").match(
            (e) => e,
            () => null,
        );
        expect(calls[0]).toEqual([
            "listRingVrfKeys",
            { owner: "app.dot", disclosure: "PublicKey" },
        ]);
        expect(entries).toEqual([
            {
                handle: sampleKeyHandle,
                rings: [{ chainId: "0x01", junctions: [] }],
                publicKey: "0xf00d",
            },
        ]);
    });

    test("ringVrfSign hex-encodes the message and hex-decodes the signature", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const signature = await provider
            .ringVrfSign(sampleKeyHandle, new Uint8Array([1, 2, 3]))
            .match(
                (sig) => sig,
                () => null,
            );
        expect(calls[0]).toEqual([
            "ringVrfSign",
            { keyHandle: sampleKeyHandle, message: toHex(new Uint8Array([1, 2, 3])) },
        ]);
        expect(signature).toEqual(fromHex("0xba5eba11"));
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
