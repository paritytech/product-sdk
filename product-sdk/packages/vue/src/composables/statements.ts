// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type PublishOptions,
    type ReceivedStatement,
    queryKeys,
    unwrapResult,
} from "@parity/product-sdk-hooks-core";
import { type Ref, onScopeDispose, ref } from "vue";
import { useRuntime } from "../context.js";
import {
    type LiveListQueryResult,
    type MaybeGetter,
    type MutationOptions,
    type NamedMutation,
    type QueryOptions,
    dropMutate,
    toGetter,
    useLiveListQuery,
    useTruapiMutation,
} from "../internal.js";

/**
 * Live statements matching the app topic (and optional `topic2`), accumulated
 * newest-last in the query cache. Empty and inert standalone.
 */
export function useStatements<T>(options?: {
    topic2?: MaybeGetter<string | undefined>;
    limit?: number;
    enabled?: MaybeGetter<boolean>;
    query?: QueryOptions<ReceivedStatement<T>[]>;
}): LiveListQueryResult<ReceivedStatement<T>> {
    const runtime = useRuntime();
    const getTopic2 = toGetter(options?.topic2 ?? (() => undefined));
    return useLiveListQuery<ReceivedStatement<T>>({
        queryKey: () => queryKeys.statements(getTopic2() ?? null),
        attach: (onValue, onError) => {
            const topic2 = getTopic2();
            return runtime.statements.subscribe<T>(onValue, {
                ...(topic2 !== undefined ? { topic2 } : {}),
                onError,
            });
        },
        limit: options?.limit ?? 500,
        enabled: options?.enabled ?? true,
        ...(options?.query !== undefined ? { query: options.query } : {}),
    });
}

export interface PublishStatementVariables<T> {
    data: T;
    options?: PublishOptions;
}

/**
 * Publish JSON payloads (≤512 bytes) to the app topic: `publish(data)`.
 * Resolves `false` standalone (nothing to publish to) and `true` once the
 * host accepted the statement; a host-side rejection rejects with the SDK's
 * `StatementStoreError` so the reason lands in `error`.
 */
export function usePublishStatement<T = unknown>(options?: {
    mutation?: MutationOptions<boolean, PublishStatementVariables<T>>;
}): NamedMutation<boolean, PublishStatementVariables<T>> & {
    publish: (data: T, publishOptions?: PublishOptions) => Promise<boolean>;
} {
    const runtime = useRuntime();
    const mutation = useTruapiMutation(
        ({ data, options: publishOptions }: PublishStatementVariables<T>) =>
            runtime.statements.publish(data, publishOptions),
        options?.mutation,
    );
    return {
        ...dropMutate(mutation),
        publish: (data: T, publishOptions?: PublishOptions) =>
            mutation.mutateAsync({
                data,
                ...(publishOptions !== undefined ? { options: publishOptions } : {}),
            }),
    };
}

export interface StatementChannel<T> {
    /** Latest value per channel name (last-write-wins). */
    values: Ref<ReadonlyMap<string, T>>;
    /** Resolves `false` while the store isn't ready (standalone); rejects with the SDK error on a host-side failure. */
    write: (channelName: string, value: T) => Promise<boolean>;
    ready: Ref<boolean>;
}

/**
 * Last-write-wins channels (presence, live cursors, ephemeral app state).
 * `ready` stays false standalone.
 */
export function useStatementChannel<T extends { timestamp?: number }>(options?: {
    topic2?: string;
}): StatementChannel<T> {
    const runtime = useRuntime();
    const values = ref<ReadonlyMap<string, T>>(new Map()) as Ref<ReadonlyMap<string, T>>;
    const ready = ref(false);
    let store: Awaited<ReturnType<typeof runtime.statements.getChannelStore<T>>> = null;
    let cancelled = false;
    let offChange: (() => void) | undefined;

    void runtime.statements
        .getChannelStore<T>(options?.topic2 !== undefined ? { topic2: options.topic2 } : undefined)
        .then((resolved) => {
            if (cancelled || !resolved) return;
            store = resolved;
            ready.value = true;
            values.value = new Map(resolved.readAll());
            const sub = resolved.onChange(() => {
                values.value = new Map(resolved.readAll());
            });
            offChange = () => sub.unsubscribe();
        })
        .catch(() => {});

    onScopeDispose(() => {
        cancelled = true;
        offChange?.();
        store?.destroy();
        store = null;
    });

    return {
        values,
        ready,
        write: async (channelName: string, value: T) => {
            if (!store) return false;
            unwrapResult(await store.write(channelName, value));
            return true;
        },
    };
}
