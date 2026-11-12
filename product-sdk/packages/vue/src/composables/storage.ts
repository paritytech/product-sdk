// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type AuthorizationStatus,
    type StoreResult,
    type UploadOptions,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
    useTruapiMutation,
    useTruapiQuery,
} from "../internal.js";

export interface UploadVariables {
    data: Uint8Array;
    options?: UploadOptions;
}

/** Upload bytes to Bulletin-backed cloud storage: `upload(data)` → CID receipt. */
export function useUpload(options?: {
    mutation?: MutationOptions<StoreResult, UploadVariables>;
}): NamedMutation<StoreResult, UploadVariables> & {
    upload: (data: Uint8Array, uploadOptions?: UploadOptions) => Promise<StoreResult>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ data, options: uploadOptions }: UploadVariables) =>
            runtime.cloudStorage.upload(data, uploadOptions),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        upload: (data: Uint8Array, uploadOptions?: UploadOptions) =>
            mutation.mutateAsync({
                data,
                ...(uploadOptions !== undefined ? { options: uploadOptions } : {}),
            }),
    };
}

/** Fetch CID content (host preimage lookup). Set `json` to parse. */
export function useCid<T = Uint8Array>(
    cid: MaybeGetter<string | undefined>,
    options?: { json?: boolean; query?: QueryOptions<T> },
): QueryResult<T> {
    const runtime = useRuntime();
    const getCid = toGetter(cid);
    return useTruapiQuery<T>(
        () => queryKeys.cid(getCid() ?? null, options?.json ?? false),
        async () => {
            const resolved = getCid();
            if (!resolved) throw new Error("product-sdk: useCid needs a cid");
            return options?.json
                ? runtime.cloudStorage.fetchJson<T>(resolved)
                : ((await runtime.cloudStorage.fetchBytes(resolved)) as T);
        },
        { ...options, enabled: () => getCid() !== undefined },
    );
}

/** Storage quota/authorization for the selected (or given) account. */
export function useStorageAuthorization(
    address?: MaybeGetter<string | undefined>,
    options?: { query?: QueryOptions<AuthorizationStatus> },
): QueryResult<AuthorizationStatus> {
    const runtime = useRuntime();
    const getAddress = toGetter(address ?? (() => undefined));
    return useTruapiQuery(
        () => queryKeys.storageAuthorization(getAddress() ?? null),
        () => runtime.cloudStorage.checkAuthorization(getAddress()),
        options,
    );
}
