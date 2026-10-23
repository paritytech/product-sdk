// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type ContextualAlias,
    HostUnavailableError,
    type ProductAccountLookup,
    type ProductProofContext,
    type RegisteredRingVrfKey,
    type RingLocation,
    type RingVRFProof,
    type RingVrfKeyDisclosure,
    type RingVrfKeyHandle,
    type RingVrfPublicKey,
    type VrfSignature,
    type VrfTranscriptItem,
    findRingVrfKeyHandle,
    formatHostError,
    getAccountsProvider,
} from "@parity/product-sdk-host";
import {
    DevProvider,
    HostProvider,
    type ProviderType,
    type SignerAccount,
    type SignerError,
    SignerManager,
    type SignerState,
} from "@parity/product-sdk-signer";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import type { AnyChains, TruapiConfig } from "./config.js";
import { type HostController, unwrapResult } from "./host.js";
import { type ReadonlyStore, createStore } from "./store.js";

/** Signer of a connected account: a PAPI 3 `TxCreator` as built by `SignerManager`. */
export type Signer = CommonSignerTxCreator;

export type {
    ContextualAlias,
    ProductAccountLookup,
    ProductProofContext,
    ProviderType,
    RegisteredRingVrfKey,
    RingLocation,
    RingVRFProof,
    RingVrfKeyDisclosure,
    RingVrfKeyHandle,
    RingVrfPublicKey,
    SignerAccount,
    SignerError,
    SignerState,
    VrfSignature,
    VrfTranscriptItem,
};
export { findRingVrfKeyHandle };

export type LoginResult = "Success" | "AlreadyConnected" | "Rejected";

export interface AccountsController {
    state: ReadonlyStore<SignerState>;
    /**
     * Connect once and share the attempt: concurrent callers await the same
     * promise, failures evict it so the next call retries. Defaults to the
     * host provider inside a container and dev accounts standalone.
     */
    connect(provider?: ProviderType): Promise<SignerAccount[]>;
    disconnect(): void;
    select(address: string): SignerAccount;
    getSigner(): Signer | null;
    signRaw(data: Uint8Array): Promise<Uint8Array>;
    /** RFC-0009 — call from a user gesture only. No-op success standalone. */
    login(reason?: string): Promise<LoginResult>;
    /** Primary DotNS username; null standalone or when not connected. */
    getUserId(): Promise<string | null>;
    /**
     * The dotNS identifier product accounts derive from: `productAccount.dotNsIdentifier`
     * when configured, else the host's product context, else `<dappName>.dot`.
     */
    getProductId(): Promise<string>;
    /**
     * The host gates signing on `ChainSubmit`; when missing, a sign request
     * hangs silently instead of erroring. Call in the click context before
     * each transaction. No-op standalone.
     */
    ensureChainSubmitPermission(): Promise<void>;
    /**
     * Sign bytes with the product account **without** the `<Bytes>` watermark,
     * for runtimes that verify a bare-byte ownership proof (People chain's
     * `register_person`). Deprecated on the host side too: the host shows a
     * stronger confirmation because such a signature can authorize a
     * transaction. Prefer `signRaw`. Host-only.
     *
     * @deprecated Temporary compatibility path; disappears once runtimes accept watermarked proofs.
     */
    signRawUnwatermarked(data: Uint8Array): Promise<Uint8Array>;
    /**
     * RFC-0023 sr25519 VRF signature over a Merlin transcript built from
     * `transcriptLabel` and `items`, signed by a product account (the
     * configured one by default). Host-only.
     */
    signVrf(
        transcriptLabel: Uint8Array,
        items: VrfTranscriptItem[],
        account?: ProductAccountLookup,
    ): Promise<VrfSignature>;
    /** RFC-0024: register a ring-VRF key owned by this product; resolves its public key. */
    registerRingVrfKey(index: number, ring: RingLocation): Promise<RingVrfPublicKey>;
    /** RFC-0024: ring-VRF keys registered by `owner` (this product by default). */
    listRingVrfKeys(
        owner?: string,
        disclosure?: RingVrfKeyDisclosure,
    ): Promise<RegisteredRingVrfKey[]>;
    /** Contextual alias for a registered key: proves ring membership without naming the account. */
    getAccountAlias(
        keyHandle: RingVrfKeyHandle,
        context: ProductProofContext,
        ring: RingLocation,
    ): Promise<ContextualAlias>;
    /** Ring-VRF proof binding `message` to the product-scoped `context`. */
    createAccountProof(
        keyHandle: RingVrfKeyHandle,
        context: ProductProofContext,
        ring: RingLocation,
        message: Uint8Array,
    ): Promise<RingVRFProof>;
    /** Plain signature under a registered ring-VRF member key (no membership proof). */
    ringVrfSign(keyHandle: RingVrfKeyHandle, message: Uint8Array): Promise<Uint8Array>;
    manager: SignerManager;
    destroy(): void;
}

export function createAccountsController<TChains extends AnyChains>(
    config: TruapiConfig<TChains>,
    host: HostController,
): AccountsController {
    // HostProvider falls back to `getProductAccount(dappName, 0)` when no
    // productAccount is configured — without dappName, host connect() resolves
    // with zero accounts.
    const dappName = config.dappName ?? "product-sdk";
    const derivationIndex = config.productAccount?.derivationIndex ?? 0;

    // Resolved before each host connect so the provider derives its account from
    // the id the host actually bound this product to (RFC: product context),
    // instead of a hard-coded `<dappName>.dot` guess.
    let resolvedProductId: string | null = config.productAccount?.dotNsIdentifier ?? null;

    const manager = new SignerManager({
        dappName,
        createProvider: (type) =>
            type === "dev"
                ? new DevProvider({})
                : new HostProvider({
                      dappName,
                      ...(resolvedProductId
                          ? {
                                productAccount: {
                                    dotNsIdentifier: resolvedProductId,
                                    derivationIndex,
                                    requestName: config.productAccount?.requestName ?? false,
                                },
                            }
                          : {}),
                  }),
    });

    const state = createStore<SignerState>(manager.getState());
    // SignerManager emits synchronously on mutation but never primes — the
    // store seed above is the priming read.
    const stopManagerSub = manager.subscribe((next) => state.set(next));

    const getProductId = async (): Promise<string> => {
        if (config.productAccount?.dotNsIdentifier) return config.productAccount.dotNsIdentifier;
        const context = await host.getProductContext().catch(() => null);
        return context?.productId ?? (dappName.includes(".") ? dappName : `${dappName}.dot`);
    };

    let connectPromise: Promise<SignerAccount[]> | null = null;
    const connect = (provider?: ProviderType): Promise<SignerAccount[]> => {
        if (!connectPromise) {
            connectPromise = (async () => {
                const resolved = provider ?? ((await host.detect()) ? "host" : "dev");
                if (resolved === "host" && !config.productAccount?.dotNsIdentifier) {
                    const context = await host.getProductContext().catch(() => null);
                    resolvedProductId = context?.productId ?? null;
                }
                const result = await manager.connect(resolved);
                if (!result.ok) throw result.error;
                return [...result.value];
            })();
            connectPromise.catch(() => {
                connectPromise = null;
            });
        }
        return connectPromise;
    };

    if (config.autoConnect) void connect().catch(() => {});

    const requireProvider = async () => {
        if (!(await host.detect())) throw new HostUnavailableError("accounts");
        const provider = await getAccountsProvider();
        if (!provider) throw new HostUnavailableError("accounts");
        return provider;
    };

    return {
        state,
        connect,
        disconnect: () => {
            connectPromise = null;
            manager.disconnect();
        },
        select: (address) => unwrapResult(manager.selectAccount(address)),
        getSigner: () => manager.getSigner(),
        signRaw: async (data) => unwrapResult(await manager.signRaw(data)),
        login: async (reason) => {
            if (!(await host.detect())) return "AlreadyConnected";
            const provider = await requireProvider();
            return provider.requestLogin(reason).match(
                (value) => value,
                (error) => {
                    throw new Error(`product-sdk: login failed: ${formatHostError(error)}`, {
                        cause: error,
                    });
                },
            );
        },
        getUserId: async () => {
            if (!(await host.detect())) return null;
            const provider = await getAccountsProvider();
            if (!provider) return null;
            return provider.getUserId().match(
                (value) => value.primaryUsername,
                () => null,
            );
        },
        getProductId,
        ensureChainSubmitPermission: async () => {
            if (!(await host.detect())) return;
            const granted = await host.requestPermission({ tag: "ChainSubmit", value: undefined });
            if (!granted)
                throw new Error("product-sdk: the host denied permission to submit transactions");
        },
        signRawUnwatermarked: async (data) => {
            await connect();
            const provider = await requireProvider();
            const selected = state.get().selectedAccount;
            if (!selected) throw new Error("product-sdk: connect an account before signing");
            return provider.signRawUnwatermarkedDeprecated(
                {
                    dotNsIdentifier: await getProductId(),
                    derivationIndex,
                    publicKey: selected.publicKey,
                },
                data,
            );
        },
        // The ring-VRF and VRF paths need a connected host provider; connect on
        // demand so callers get the same click-to-sign ergonomics as `tx.submit`.
        signVrf: async (transcriptLabel, items, account) => {
            await connect();
            const target = account ?? { dotNsIdentifier: await getProductId(), derivationIndex };
            return unwrapResult(await manager.signVrf(target, transcriptLabel, items));
        },
        registerRingVrfKey: async (index, ring) => {
            await connect();
            return unwrapResult(await manager.registerRingVrfKey(index, ring));
        },
        // Listing is a read: go through the host accounts provider so mounting a
        // query never forces a wallet connection (and its prompts) on the user.
        listRingVrfKeys: async (owner, disclosure) => {
            const provider = await requireProvider();
            return provider.listRingVrfKeys(owner ?? (await getProductId()), disclosure).match(
                (value) => value,
                (error) => {
                    throw new Error(
                        `product-sdk: listRingVrfKeys failed: ${formatHostError(error)}`,
                        {
                            cause: error,
                        },
                    );
                },
            );
        },
        getAccountAlias: async (keyHandle, context, ring) => {
            await connect();
            return unwrapResult(await manager.getProductAccountAlias(keyHandle, context, ring));
        },
        createAccountProof: async (keyHandle, context, ring, message) => {
            await connect();
            return unwrapResult(
                await manager.createRingVRFProof(keyHandle, context, ring, message),
            );
        },
        ringVrfSign: async (keyHandle, message) => {
            // Not on SignerManager yet — go through the host accounts provider directly.
            const provider = await requireProvider();
            return provider.ringVrfSign(keyHandle, message).match(
                (value) => value,
                (error) => {
                    throw new Error(`product-sdk: ringVrfSign failed: ${formatHostError(error)}`, {
                        cause: error,
                    });
                },
            );
        },
        manager,
        destroy: () => {
            stopManagerSub();
            manager.destroy();
        },
    };
}
