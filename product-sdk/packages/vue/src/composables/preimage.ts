// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { type HexString, queryKeys } from "@parity/product-sdk-hooks-core";
import { useRuntime } from "../context.js";
import {
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    type QueryResult,
    dropMutate,
    toGetter,
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
    key: MaybeGetter<HexString | undefined>,
    options?: { enabled?: MaybeGetter<boolean>; query?: QueryOptions<Uint8Array | null> },
): QueryResult<Uint8Array | null> {
    const runtime = useRuntime();
    const getKey = toGetter(key);
    const enabled = toGetter(options?.enabled ?? true);
    return useLiveQuery<Uint8Array | null>({
        queryKey: () => queryKeys.preimage(getKey() ?? null),
        attach: (onValue, onError) =>
            runtime.preimage.watch(getKey() ?? "0x", onValue, { onError }),
        enabled: () => getKey() !== undefined && enabled() !== false,
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
    return {
        ...dropMutate(mutation),
        submit: (value: Uint8Array) => mutation.mutateAsync(value),
    };
}
