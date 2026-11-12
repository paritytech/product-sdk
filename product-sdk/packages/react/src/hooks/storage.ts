// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { UseQueryResult } from "@tanstack/react-query";
import {
    type AuthorizationStatus,
    type StoreResult,
    type UploadOptions,
    queryKeys,
} from "@parity/product-sdk-hooks-core";
import { useCallback } from "react";
import { useRuntime } from "../context.js";
import {
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    dropMutate,
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
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        upload: useCallback(
            (data: Uint8Array, uploadOptions?: UploadOptions) =>
                mutateAsync({
                    data,
                    ...(uploadOptions !== undefined ? { options: uploadOptions } : {}),
                }),
            [mutateAsync],
        ),
    };
}

/** Fetch CID content (host preimage lookup). Set `json` to parse. */
export function useCid<T = Uint8Array>(
    cid: string | undefined,
    options?: { json?: boolean; query?: QueryOptions<T> },
): UseQueryResult<T, Error> {
    const runtime = useRuntime();
    return useTruapiQuery<T>(
        queryKeys.cid(cid ?? null, options?.json ?? false),
        async () => {
            if (!cid) throw new Error("product-sdk: useCid needs a cid");
            return options?.json
                ? runtime.cloudStorage.fetchJson<T>(cid)
                : ((await runtime.cloudStorage.fetchBytes(cid)) as T);
        },
        { ...options, enabled: cid !== undefined },
    );
}

/** Storage quota/authorization for the selected (or given) account. */
export function useStorageAuthorization(
    address?: string,
    options?: { query?: QueryOptions<AuthorizationStatus> },
): UseQueryResult<AuthorizationStatus, Error> {
    const runtime = useRuntime();
    return useTruapiQuery(
        queryKeys.storageAuthorization(address ?? null),
        () => runtime.cloudStorage.checkAuthorization(address),
        options,
    );
}
