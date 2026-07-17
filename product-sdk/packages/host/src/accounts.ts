// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Host wallet accounts, backed by `truApi.account.*` and `truApi.signing.*`.
 *
 * `getAccountsProvider()` returns the full accounts surface — user identity
 * (`getUserId` / `requestLogin`), the user's existing wallet accounts
 * (`getLegacyAccounts`), app-scoped product accounts (`getProductAccount` /
 * `getProductAccountAlias`), Ring VRF proofs (`createRingVRFProof`), connection
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
    HostAccountConnectionStatusSubscribeItem,
    HostAccountGetAliasResponse as WireAlias,
    HostRequestLoginResponse,
    LegacyAccount as WireLegacyAccount,
    ProductAccount as WireProductAccount,
    ProductAccountId,
    RingLocation,
    TrUApiClient,
    VersionedHostAccountCreateProofError,
    VersionedHostAccountGetAliasError,
    VersionedHostAccountGetError,
    VersionedHostGetLegacyAccountsError,
    VersionedHostGetUserIdError,
    VersionedHostRequestLoginError,
    scale,
} from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import { fromHex, toHex, unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/** Ring location for Ring VRF proofs (`{ genesisHash, ringRootHash, hints? }`). Re-exported from `@parity/truapi`. */
export type { RingLocation } from "@parity/truapi";

// The account/alias shapes come from `@parity/truapi`'s generated specs; we
// derive the SDK-facing views from them so the field inventory tracks the
// protocol automatically, and override only the byte fields the adapter
// decodes (the wire types carry `0x`-prefixed `HexString`s, whereas these
// surface decoded `Uint8Array`s). Same pattern as `@parity/product-sdk-statement-store`.

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
 * `publicKey` decoded to bytes.
 */
export type ProductAccount = ProductAccountId &
    Omit<WireProductAccount, "publicKey"> & {
        /** Raw public key bytes. */
        publicKey: Uint8Array;
    };

/**
 * A contextual alias obtained from Ring VRF.
 *
 * Proves account membership in a ring without revealing which account.
 *
 * Derived from `@parity/truapi`'s alias response, with both fields decoded to bytes.
 */
export type ContextualAlias = { [K in keyof WireAlias]: Uint8Array };

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
    getProductAccountAlias(
        dotNsIdentifier: string,
        derivationIndex?: number,
    ): ResultAsync<ContextualAlias, scale.CallErrorValue<VersionedHostAccountGetAliasError>>;
    getLegacyAccounts(): ResultAsync<
        HostAccount[],
        scale.CallErrorValue<VersionedHostGetLegacyAccountsError>
    >;
    createRingVRFProof(
        dotNsIdentifier: string,
        derivationIndex: number,
        location: RingLocation,
        message: Uint8Array,
    ): ResultAsync<Uint8Array, scale.CallErrorValue<VersionedHostAccountCreateProofError>>;
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
                .getAccount({ productAccountId: { dotNsIdentifier, derivationIndex } })
                .map((response) => ({
                    publicKey: fromHex(response.account.publicKey),
                    dotNsIdentifier,
                    derivationIndex,
                }));
        },
        getProductAccountAlias(dotNsIdentifier, derivationIndex = 0) {
            return account
                .getAccountAlias({ productAccountId: { dotNsIdentifier, derivationIndex } })
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
        createRingVRFProof(dotNsIdentifier, derivationIndex, location, message) {
            return account
                .createAccountProof({
                    productAccountId: { dotNsIdentifier, derivationIndex },
                    ringLocation: location,
                    context: toHex(message),
                })
                .map((response) => fromHex(response.proof));
        },
        getProductAccountSigner(account_) {
            const productAccountId = {
                dotNsIdentifier: account_.dotNsIdentifier,
                derivationIndex: account_.derivationIndex,
            };

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
                createAccountProof: method("createAccountProof", { proof: "0xc0ffee" }),
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
            { productAccountId: { dotNsIdentifier: "app.dot", derivationIndex: 2 } },
        ]);
        expect(account).toEqual({
            publicKey: fromHex("0xaa"),
            dotNsIdentifier: "app.dot",
            derivationIndex: 2,
        });
    });

    test("createRingVRFProof hex-encodes the message as the proof context", async () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = adaptAccountsProvider(client);
        const proof = await provider
            .createRingVRFProof(
                "app.dot",
                0,
                { genesisHash: "0x01", ringRootHash: "0x02" },
                new Uint8Array([1, 2, 3]),
            )
            .match(
                (p) => p,
                () => null,
            );
        expect(calls[0][0]).toBe("createAccountProof");
        expect((calls[0][1] as { context: string }).context).toBe(toHex(new Uint8Array([1, 2, 3])));
        expect(proof).toEqual(fromHex("0xc0ffee"));
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
                account: { dotNsIdentifier: "app.dot", derivationIndex: 0 },
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
                signer: { dotNsIdentifier: "app.dot", derivationIndex: 0 },
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
