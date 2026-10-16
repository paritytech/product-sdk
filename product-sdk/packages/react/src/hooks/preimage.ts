// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { UseQueryResult } from "@tanstack/react-query";
import { type HexString, queryKeys } from "@parity/product-sdk-hooks-core";
import { useCallback } from "react";
import { useRuntime } from "../context.js";
import {
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    dropMutate,
    useLiveQuery,
    useTruapiMutation,
} from "../internal.js";

/**
 * Live lookup of the preimage behind `key` (Bulletin-backed, via the host).
 * `data` is the bytes, or `null` while the host is still searching. Disabled
 * while `key` is `undefined`; host-only — standalone the query errors with
 * `HostUnavailableError`.
 */
export function usePreimage(
    key: HexString | undefined,
    options?: { enabled?: boolean; query?: QueryOptions<Uint8Array | null> },
): UseQueryResult<Uint8Array | null, Error> {
    const runtime = useRuntime();
    return useLiveQuery<Uint8Array | null>({
        queryKey: queryKeys.preimage(key ?? null),
        attach: (onValue, onError) => runtime.preimage.watch(key ?? "0x", onValue, { onError }),
        enabled: key !== undefined && (options?.enabled ?? true),
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

/** Submit a preimage through the host: `submit(bytes)` resolves its `0x` key (hash). Host-only. */
export function useSubmitPreimage(options?: {
    mutation?: MutationOptions<HexString, Uint8Array>;
}): NamedMutation<HexString, Uint8Array> & {
    submit: (value: Uint8Array) => Promise<HexString>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        (value: Uint8Array) => runtime.preimage.submit(value),
        options?.mutation,
    );
    const { mutateAsync } = mutation;
    return {
        ...dropMutate(mutation),
        submit: useCallback((value: Uint8Array) => mutateAsync(value), [mutateAsync]),
    };
}
