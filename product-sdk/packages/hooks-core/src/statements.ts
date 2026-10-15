// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    ChannelStore,
    type PublishOptions,
    type ReceivedStatement,
    StatementStoreClient,
} from "@parity/product-sdk-statement-store";
import type { AnyChains, TruapiConfig } from "./config.js";
import { type HostController, unwrapResult } from "./host.js";

export type { PublishOptions, ReceivedStatement };

export interface StatementsController {
    /**
     * Connect-once client (`mode: "host"`); resolves null standalone so
     * features degrade instead of crashing. Failures evict the cached attempt.
     */
    getClient(): Promise<StatementStoreClient | null>;
    /**
     * Resolves `false` standalone (message silently undeliverable — callers
     * decide) and `true` once the host accepted the statement. A host-side
     * rejection throws the SDK's `StatementStoreError` (too large, not
     * connected, network rejected) so the reason reaches the caller.
     */
    publish<T>(data: T, options?: PublishOptions): Promise<boolean>;
    subscribe<T>(
        onStatement: (statement: ReceivedStatement<T>) => void,
        options?: { topic2?: string; onError?: (error: unknown) => void },
    ): () => void;
    /** Last-write-wins channel map scoped by optional topic2; null standalone. */
    getChannelStore<T extends { timestamp?: number }>(options?: {
        topic2?: string;
    }): Promise<ChannelStore<T> | null>;
    destroy(): void;
}

export function createStatementsController<TChains extends AnyChains>(
    config: TruapiConfig<TChains>,
    host: HostController,
): StatementsController {
    let clientPromise: Promise<StatementStoreClient | null> | null = null;
    const appName = config.statements?.appName ?? config.dappName ?? "product-sdk";

    const getClient = (): Promise<StatementStoreClient | null> => {
        if (!clientPromise) {
            clientPromise = (async () => {
                if (!(await host.detect())) return null;
                const client = new StatementStoreClient({
                    appName,
                    ...(config.statements?.defaultTtlSeconds !== undefined
                        ? { defaultTtlSeconds: config.statements.defaultTtlSeconds }
                        : {}),
                });
                await client.connect({ mode: "host" });
                return client;
            })();
            clientPromise.catch(() => {
                clientPromise = null;
            });
        }
        return clientPromise;
    };

    return {
        getClient,
        publish: async (data, options) => {
            const client = await getClient();
            if (!client) return false;
            unwrapResult(await client.publish(data, options));
            return true;
        },
        subscribe: (onStatement, options) => {
            let cancelled = false;
            let teardown: (() => void) | undefined;
            void getClient()
                .then((client) => {
                    if (cancelled || !client) return;
                    const sub = client.subscribe(
                        onStatement,
                        options?.topic2 !== undefined ? { topic2: options.topic2 } : undefined,
                    );
                    teardown = () => sub.unsubscribe();
                    if (cancelled) teardown();
                })
                .catch((e) => {
                    if (!cancelled) options?.onError?.(e);
                });
            return () => {
                cancelled = true;
                teardown?.();
            };
        },
        getChannelStore: async (options) => {
            const client = await getClient();
            if (!client) return null;
            return new ChannelStore(client, options);
        },
        destroy: () => {
            clientPromise?.then((client) => client?.destroy()).catch(() => {});
            clientPromise = null;
        },
    };
}
