// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type ContextualAlias,
    type LoginResult,
    type ProductAccountLookup,
    type ProductProofContext,
    type ProviderType,
    type RegisteredRingVrfKey,
    type RingLocation,
    type RingVRFProof,
    type RingVrfKeyDisclosure,
    type RingVrfKeyHandle,
    type RingVrfPublicKey,
    type Signer,
    type SignerAccount,
    type SignerError,
    type SignerState,
    type VrfSignature,
    type VrfTranscriptItem,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { type ComputedRef, computed } from "vue";
import { useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type OptionalVariables,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
    useStore,
    useTruapiMutation,
    useTruapiQuery,
} from "../internal.js";

export interface AccountsResult {
    accounts: ComputedRef<readonly SignerAccount[]>;
    selectedAccount: ComputedRef<SignerAccount | null>;
    status: ComputedRef<SignerState["status"]>;
    error: ComputedRef<SignerError | null>;
    isConnected: ComputedRef<boolean>;
    isConnecting: ComputedRef<boolean>;
    connect: (provider?: ProviderType) => Promise<SignerAccount[]>;
    disconnect: () => void;
    select: (address: string) => SignerAccount;
}

/** Wallet state + connect/disconnect/select, backed by the shared SignerManager. */
export function useAccounts(): AccountsResult {
    const runtime = useRuntime();
    const state = useStore(runtime.accounts.state);
    return {
        accounts: computed(() => state.value.accounts),
        selectedAccount: computed(() => state.value.selectedAccount),
        status: computed(() => state.value.status),
        error: computed(() => state.value.error),
        isConnected: computed(() => state.value.status === "connected"),
        isConnecting: computed(() => state.value.status === "connecting"),
        connect: (provider) => runtime.accounts.connect(provider),
        disconnect: () => runtime.accounts.disconnect(),
        select: (address) => runtime.accounts.select(address),
    };
}

/** The currently selected account, or null. */
export function useSelectedAccount(): ComputedRef<SignerAccount | null> {
    const state = useStore(useRuntime().accounts.state);
    return computed(() => state.value.selectedAccount);
}

/** Connect with mutation state: `connect(provider?)` plus `isPending`/`error`/`data`. */
export function useConnect(options?: {
    mutation?: MutationOptions<SignerAccount[], OptionalVariables<ProviderType>>;
}): NamedMutation<SignerAccount[], OptionalVariables<ProviderType>> & {
    connect: (provider?: ProviderType) => Promise<SignerAccount[]>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (provider: OptionalVariables<ProviderType>) =>
            runtime.accounts.connect(provider ?? undefined),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        connect: (provider?: ProviderType) => mutation.mutateAsync(provider),
    };
}

export function useDisconnect(): () => void {
    const runtime = useRuntime();
    return () => runtime.accounts.disconnect();
}

/** Signer (PAPI `TxCreator`) of the selected account (null until connected). */
export function useSigner(): ComputedRef<Signer | null> {
    const runtime = useRuntime();
    const state = useStore(runtime.accounts.state);
    return computed(() => {
        void state.value; // recompute on signer changes
        return runtime.accounts.getSigner();
    });
}

/** RFC-0009 login — call `login()` from a user gesture. */
export function useLogin(options?: {
    mutation?: MutationOptions<LoginResult, OptionalVariables<string>>;
}): NamedMutation<LoginResult, OptionalVariables<string>> & {
    login: (reason?: string) => Promise<LoginResult>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (reason: OptionalVariables<string>) => runtime.accounts.login(reason ?? undefined),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        login: (reason?: string) => mutation.mutateAsync(reason),
    };
}

/** The user's primary DotNS username; null standalone or when not logged in. */
export function useUserId(options?: {
    query?: QueryOptions<string | null>;
}): QueryResult<string | null> {
    const runtime = useRuntime();
    return useTruapiQuery(
        () => queryKeys.userId(),
        () => runtime.accounts.getUserId(),
        options,
    );
}

/** Sign arbitrary bytes with the selected account: `sign(data)`. */
export function useSignRaw(options?: {
    mutation?: MutationOptions<Uint8Array, Uint8Array>;
}): NamedMutation<Uint8Array, Uint8Array> & {
    sign: (data: Uint8Array) => Promise<Uint8Array>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (data: Uint8Array) => runtime.accounts.signRaw(data),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        sign: (data: Uint8Array) => mutation.mutateAsync(data),
    };
}

/**
 * Sign bytes with the product account **without** the `<Bytes>` watermark, for
 * runtimes that verify a bare-byte ownership proof (People chain's
 * `register_person`). The host shows a stronger confirmation because such a
 * signature can authorize a transaction; prefer `useSignRaw` everywhere a
 * runtime does not force otherwise. Host-only.
 *
 * @deprecated Temporary compatibility path, deprecated host-side too; disappears once runtimes accept watermarked proofs.
 */
export function useSignRawUnwatermarked(options?: {
    mutation?: MutationOptions<Uint8Array, Uint8Array>;
}): NamedMutation<Uint8Array, Uint8Array> & {
    sign: (data: Uint8Array) => Promise<Uint8Array>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (data: Uint8Array) => runtime.accounts.signRawUnwatermarked(data),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        sign: (data: Uint8Array) => mutation.mutateAsync(data),
    };
}

export interface SignVrfVariables {
    /** Root domain-separation label: `Transcript::new(transcriptLabel)`. */
    transcriptLabel: Uint8Array;
    /** Transcript items replayed in order as `append_message(label, value)`. */
    items: VrfTranscriptItem[];
    /** Product account to sign with; defaults to the configured/derived product account 0. */
    account?: ProductAccountLookup;
}

/**
 * RFC-0023 sr25519 VRF signature from a product account: `sign(label, items)`.
 * Deterministic for the same transcript, so put per-round values in `items`.
 * Host-only; standalone the call rejects with `HostUnavailableError`.
 */
export function useSignVrf(options?: {
    mutation?: MutationOptions<VrfSignature, SignVrfVariables>;
}): NamedMutation<VrfSignature, SignVrfVariables> & {
    sign: (
        transcriptLabel: Uint8Array,
        items: VrfTranscriptItem[],
        account?: ProductAccountLookup,
    ) => Promise<VrfSignature>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ transcriptLabel, items, account }: SignVrfVariables) =>
            runtime.accounts.signVrf(transcriptLabel, items, account),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        sign: (transcriptLabel, items, account) =>
            mutation.mutateAsync({
                transcriptLabel,
                items,
                ...(account !== undefined ? { account } : {}),
            }),
    };
}

/**
 * RFC-0024 ring-VRF keys registered by `owner` (this product by default).
 * Use the returned `handle`s for aliases and proofs instead of hard-coding a
 * derivation index. Host-only: standalone the query errors with `HostUnavailableError`.
 */
export function useRingVrfKeys(
    owner?: MaybeGetter<string | undefined>,
    options?: { disclosure?: RingVrfKeyDisclosure; query?: QueryOptions<RegisteredRingVrfKey[]> },
): QueryResult<RegisteredRingVrfKey[]> {
    const runtime = useRuntime();
    const getOwner = toGetter(owner ?? (() => undefined));
    const disclosure = options?.disclosure ?? "Anonymized";
    return useTruapiQuery(
        () => queryKeys.ringVrfKeys(getOwner() ?? null, disclosure),
        () => runtime.accounts.listRingVrfKeys(getOwner(), disclosure),
        options,
    );
}

export interface RegisterRingVrfKeyVariables {
    /** Key derivation index within this product's ring-VRF domain. */
    index: number;
    /** Ring the key is declared for. */
    ring: RingLocation;
}

/** Register a ring-VRF key owned by this product: `register(index, ring)` resolves its public key. */
export function useRegisterRingVrfKey(options?: {
    mutation?: MutationOptions<RingVrfPublicKey, RegisterRingVrfKeyVariables>;
}): NamedMutation<RingVrfPublicKey, RegisterRingVrfKeyVariables> & {
    register: (index: number, ring: RingLocation) => Promise<RingVrfPublicKey>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ index, ring }: RegisterRingVrfKeyVariables) =>
            runtime.accounts.registerRingVrfKey(index, ring),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        register: (index, ring) => mutation.mutateAsync({ index, ring }),
    };
}

export interface AccountAliasVariables {
    keyHandle: RingVrfKeyHandle;
    context: ProductProofContext;
    ring: RingLocation;
}

/** Contextual alias for a registered ring-VRF key — proves ring membership without naming the account: `derive(handle, context, ring)`. */
export function useAccountAlias(options?: {
    mutation?: MutationOptions<ContextualAlias, AccountAliasVariables>;
}): NamedMutation<ContextualAlias, AccountAliasVariables> & {
    derive: (
        keyHandle: RingVrfKeyHandle,
        context: ProductProofContext,
        ring: RingLocation,
    ) => Promise<ContextualAlias>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ keyHandle, context, ring }: AccountAliasVariables) =>
            runtime.accounts.getAccountAlias(keyHandle, context, ring),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        derive: (keyHandle, context, ring) => mutation.mutateAsync({ keyHandle, context, ring }),
    };
}

export interface AccountProofVariables extends AccountAliasVariables {
    message: Uint8Array;
}

/** Ring-VRF proof binding `message` to a product-scoped context: `prove(handle, context, ring, message)`. */
export function useCreateAccountProof(options?: {
    mutation?: MutationOptions<RingVRFProof, AccountProofVariables>;
}): NamedMutation<RingVRFProof, AccountProofVariables> & {
    prove: (
        keyHandle: RingVrfKeyHandle,
        context: ProductProofContext,
        ring: RingLocation,
        message: Uint8Array,
    ) => Promise<RingVRFProof>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ keyHandle, context, ring, message }: AccountProofVariables) =>
            runtime.accounts.createAccountProof(keyHandle, context, ring, message),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        prove: (keyHandle, context, ring, message) =>
            mutation.mutateAsync({ keyHandle, context, ring, message }),
    };
}

export interface RingVrfSignVariables {
    keyHandle: RingVrfKeyHandle;
    message: Uint8Array;
}

/** Plain signature under a registered ring-VRF member key (no membership proof): `sign(handle, message)`. */
export function useRingVrfSign(options?: {
    mutation?: MutationOptions<Uint8Array, RingVrfSignVariables>;
}): NamedMutation<Uint8Array, RingVrfSignVariables> & {
    sign: (keyHandle: RingVrfKeyHandle, message: Uint8Array) => Promise<Uint8Array>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ keyHandle, message }: RingVrfSignVariables) =>
            runtime.accounts.ringVrfSign(keyHandle, message),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        sign: (keyHandle, message) => mutation.mutateAsync({ keyHandle, message }),
    };
}
