// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import {
    type AnyChains,
    type TruapiConfig,
    type TruapiRuntime,
    createRuntime,
} from "@parity/product-sdk-hooks-core";
import { type ReactNode, createContext, createElement, useContext, useRef } from "react";

/**
 * Register the app's config type once for typed chain keys in every hook:
 *
 * ```ts
 * const config = defineConfig({ chains: { assetHub: { ... } } });
 * declare module "@parity/product-sdk-react" {
 *   interface Register { config: typeof config }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation point
export interface Register {}

export type ResolvedChains = Register extends { config: TruapiConfig<infer TChains> }
    ? TChains
    : AnyChains;

export type ChainKey = keyof ResolvedChains & string;

const RuntimeContext = createContext<TruapiRuntime | null>(null);

/** Defaults applied when `TruapiProvider` creates its own QueryClient. */
export function createTruapiQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            // Chain reads stay fresh for a few seconds so remounts and duplicate
            // hooks don't hammer the RPC; override per hook via `query.staleTime`
            // or bring your own QueryClient.
            queries: { staleTime: 5_000 },
        },
    });
}

export interface TruapiProviderProps {
    config?: TruapiConfig<any>;
    /** Pass a pre-built runtime instead of `config` to control its lifecycle yourself. */
    runtime?: TruapiRuntime<any>;
    /**
     * TanStack QueryClient to use. Defaults to the app's own client when the
     * provider is rendered under a `QueryClientProvider`, otherwise a client
     * with product-sdk defaults is created and provided for you.
     */
    queryClient?: QueryClient;
    children?: ReactNode;
}

export function TruapiProvider({ config, runtime, queryClient, children }: TruapiProviderProps) {
    const owned = useRef<TruapiRuntime | null>(null);
    if (!runtime && !owned.current) {
        if (!config) throw new Error("product-sdk: TruapiProvider needs a `config` or a `runtime`");
        owned.current = createRuntime(config);
    }
    // The provider-owned runtime lives for the page lifetime: destroying the
    // SignerManager is terminal, and StrictMode's throwaway unmount would kill
    // it mid-app. Pass `runtime` to own teardown explicitly.
    const value = runtime ?? owned.current;

    const inherited = useContext(QueryClientContext);
    const ownedClient = useRef<QueryClient | null>(null);
    const tree = createElement(RuntimeContext.Provider, { value }, children);

    // Reuse the app's QueryClient when one is already provided (shared cache
    // and devtools) unless the caller overrides it explicitly.
    if (inherited && !queryClient) return tree;
    let client = queryClient;
    if (!client) {
        if (!ownedClient.current) ownedClient.current = createTruapiQueryClient();
        client = ownedClient.current;
    }
    return createElement(QueryClientProvider, { client }, tree);
}

export function useRuntime(): TruapiRuntime<ResolvedChains> {
    const runtime = useContext(RuntimeContext);
    if (!runtime) {
        throw new Error("product-sdk: wrap your app in <TruapiProvider config={...}> to use hooks");
    }
    return runtime as TruapiRuntime<ResolvedChains>;
}
