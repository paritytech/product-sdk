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
 * **Provenance.** The provider mirrors `@novasamatech/host-api-wrapper`'s
 * `createAccountsProvider` (`dist/accounts.js`); the lookup/proof methods are
 * re-pointed onto `truApi.account.*` and the signer factories onto
 * `truApi.signing.*`. truapi exposes the signing primitives but not the
 * `PolkadotSigner` adapter, so the `signTx`/`signBytes` construction
 * (metadata-driven `txExtVersion` derivation, signed-extension mapping) is
 * carried over from the upstream module.
 *
 * @module
 */

import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { ResultAsync } from "neverthrow";
import { AccountId, type PolkadotSigner } from "polkadot-api";
import { getPolkadotSignerFromPjs, type SignerPayloadJSON } from "polkadot-api/pjs-signer";

import type {
    HexString,
    HostAccountConnectionStatusSubscribeItem,
    HostAccountCreateProofError,
    HostAccountGetAliasResponse as WireAlias,
    HostAccountGetError,
    HostGetUserIdError,
    HostRequestLoginError,
    HostRequestLoginResponse,
    HostSignPayloadData,
    LegacyAccount as WireLegacyAccount,
    ProductAccount as WireProductAccount,
    ProductAccountId,
    RingLocation,
    TrUApiClient,
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
 * the signer factories return a synchronous PAPI `PolkadotSigner`.
 */
export interface AccountsProvider {
    getUserId(): ResultAsync<{ primaryUsername: string }, HostGetUserIdError>;
    requestLogin(reason?: string): ResultAsync<HostRequestLoginResponse, HostRequestLoginError>;
    getProductAccount(
        dotNsIdentifier: string,
        derivationIndex?: number,
    ): ResultAsync<ProductAccount, HostAccountGetError>;
    getProductAccountAlias(
        dotNsIdentifier: string,
        derivationIndex?: number,
    ): ResultAsync<ContextualAlias, HostAccountGetError>;
    getLegacyAccounts(): ResultAsync<HostAccount[], HostAccountGetError>;
    createRingVRFProof(
        dotNsIdentifier: string,
        derivationIndex: number,
        location: RingLocation,
        message: Uint8Array,
    ): ResultAsync<Uint8Array, HostAccountCreateProofError>;
    /**
     * Build a `PolkadotSigner` for a product account. `signerType` defaults to
     * `"createTransaction"` (the host decodes metadata and forwards opaque
     * signed-extension bytes); `"signPayload"` routes via the PJS bridge and is
     * retained for backward compatibility.
     */
    getProductAccountSigner(
        account: ProductAccount,
        signerType?: "signPayload" | "createTransaction",
    ): PolkadotSigner;
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

/** Ensure a `0x` prefix on a hex string (PJS payload fields arrive with or without it). */
function asHex(value: string): HexString {
    return (value.startsWith("0x") ? value : `0x${value}`) as HexString;
}

/** Map a PJS `SignerPayloadJSON` onto the host's {@link HostSignPayloadData}. */
function buildSigningPayloadFields(payload: SignerPayloadJSON): HostSignPayloadData {
    return {
        blockHash: asHex(payload.blockHash),
        blockNumber: asHex(payload.blockNumber),
        era: asHex(payload.era),
        genesisHash: asHex(payload.genesisHash),
        method: asHex(payload.method),
        nonce: asHex(payload.nonce),
        specVersion: asHex(payload.specVersion),
        transactionVersion: asHex(payload.transactionVersion),
        tip: asHex(payload.tip),
        metadataHash: payload.metadataHash ? asHex(payload.metadataHash) : undefined,
        // PJS types assetId as `number | object`; the host expects the encoded
        // hex form, which is what PAPI produces at runtime. Passed through as
        // the wrapper did.
        assetId:
            payload.assetId !== undefined ? (payload.assetId as unknown as HexString) : undefined,
        mode: payload.mode,
        withSignedTransaction: payload.withSignedTransaction,
        signedExtensions: payload.signedExtensions,
        version: payload.version,
    };
}

/** Build an {@link AccountsProvider} over a TruAPI client's `account` / `signing` domains. */
function adaptAccountsProvider(client: TrUApiClient): AccountsProvider {
    const account = client.account;
    const signing = client.signing;

    /** Build the product-account signer's PJS-bridge signing callbacks (deprecated `signPayload` mode). */
    function productPjsSigner(productAccountId: {
        dotNsIdentifier: string;
        derivationIndex: number;
    }) {
        return getPolkadotSignerFromPjs(
            // Address slot is unused for product signing but PJS requires a string.
            "",
            async (payload) => {
                const response = await unwrapHostResult(
                    signing.signPayload({
                        account: productAccountId,
                        payload: buildSigningPayloadFields(payload),
                    }),
                    "signPayload failed",
                );
                return {
                    signature: response.signature,
                    signedTransaction: response.signedTransaction,
                };
            },
            async (raw) => {
                const response = await unwrapHostResult(
                    signing.signRaw({
                        account: productAccountId,
                        payload: { tag: "Bytes", value: { bytes: asHex(raw.data) } },
                    }),
                    "signRaw failed",
                );
                return { id: 0, signature: response.signature };
            },
        );
    }

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
        getProductAccountSigner(account_, signerType = "createTransaction") {
            const productAccountId = {
                dotNsIdentifier: account_.dotNsIdentifier,
                derivationIndex: account_.derivationIndex,
            };

            if (signerType === "signPayload") {
                return productPjsSigner(productAccountId);
            }

            return {
                publicKey: account_.publicKey,
                async signTx(callData, signedExtensions, metadata) {
                    // The host needs the extrinsic-extension version: v4 → 0,
                    // otherwise the latest supported version. unifyMetadata
                    // normalizes v14/v15 so `.extrinsic.version` is an array.
                    const versions = unifyMetadata(decAnyMetadata(metadata)).extrinsic.version;
                    if (versions.length === 0) {
                        throw new Error("No extrinsic version found in metadata");
                    }
                    const latestVersion = versions.reduce((acc, v) => Math.max(acc, v), 0);
                    const txExtVersion = latestVersion === 4 ? 0 : latestVersion;

                    const checkGenesis = signedExtensions.CheckGenesis;
                    if (!checkGenesis) {
                        throw new Error("Can't find genesis hash on transaction");
                    }

                    const response = await unwrapHostResult(
                        signing.createTransaction({
                            signer: productAccountId,
                            genesisHash: toHex(checkGenesis.additionalSigned),
                            callData: toHex(callData),
                            extensions: Object.values(signedExtensions).map((ext) => ({
                                id: ext.identifier,
                                extra: toHex(ext.value),
                                additionalSigned: toHex(ext.additionalSigned),
                            })),
                            txExtVersion,
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
            // The pjs `address` is propagated verbatim into the wire `signer`
            // field, so it must be an SS58 address the wallet can match — not a
            // raw hex public key.
            const ss58Address = AccountId().dec(account_.publicKey);
            return getPolkadotSignerFromPjs(
                ss58Address,
                async (payload) => {
                    const response = await unwrapHostResult(
                        signing.signPayloadWithLegacyAccount({
                            signer: payload.address,
                            payload: buildSigningPayloadFields(payload),
                        }),
                        "signPayloadWithLegacyAccount failed",
                    );
                    return {
                        signature: response.signature,
                        signedTransaction: response.signedTransaction,
                    };
                },
                async (raw) => {
                    const response = await unwrapHostResult(
                        signing.signRawWithLegacyAccount({
                            signer: raw.address,
                            payload: { tag: "Bytes", value: { bytes: asHex(raw.data) } },
                        }),
                        "signRawWithLegacyAccount failed",
                    );
                    return { id: 0, signature: response.signature };
                },
            );
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
                signRaw: method("signRaw", { signature: "0xbeef" }),
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
}
