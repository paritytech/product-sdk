// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, VUE_QUERY_CLIENT, VueQueryPlugin } from "@tanstack/vue-query";
import {
    type AnyChains,
    type TruapiConfig,
    type TruapiRuntime,
    createRuntime,
} from "@parity/product-sdk-hooks-core";
import { type App, type InjectionKey, type Plugin, inject } from "vue";

/**
 * Register the app's config type once for typed chain keys in every composable:
 *
 * ```ts
 * const config = defineConfig({ chains: { assetHub: { ... } } });
 * declare module "@parity/product-sdk-vue" {
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

export const RUNTIME_KEY: InjectionKey<TruapiRuntime> = Symbol("product-sdk-runtime");

/** Defaults applied when `TruapiPlugin` creates its own QueryClient. */
export function createTruapiQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            // Chain reads stay fresh for a few seconds so remounts and duplicate
            // composables don't hammer the RPC; override per composable via
            // `query.staleTime` or bring your own QueryClient.
            queries: { staleTime: 5_000 },
        },
    });
}

export interface TruapiPluginOptions {
    config?: TruapiConfig<any>;
    /** Pass a pre-built runtime instead of `config` to control its lifecycle yourself. */
    runtime?: TruapiRuntime<any>;
    /**
     * TanStack QueryClient to use. Defaults to the app's own client when
     * `VueQueryPlugin` is already installed, otherwise a client with product-sdk
     * defaults is installed for you.
     */
    queryClient?: QueryClient;
}

/**
 * ```ts
 * app.use(TruapiPlugin, { config });
 * ```
 */
export const TruapiPlugin: Plugin<[TruapiPluginOptions]> = {
    install(app: App, options: TruapiPluginOptions) {
        const runtime =
            options.runtime ??
            (options.config
                ? createRuntime(options.config)
                : (() => {
                      throw new Error("product-sdk: TruapiPlugin needs a `config` or a `runtime`");
                  })());
        app.provide(RUNTIME_KEY, runtime);

        // Reuse the app's QueryClient when VueQueryPlugin is already installed
        // (shared cache and devtools) unless the caller overrides it explicitly.
        const provides = (app as unknown as { _context: { provides: Record<string, unknown> } })
            ._context.provides;
        const hasVueQuery = provides[VUE_QUERY_CLIENT] !== undefined;
        if (options.queryClient) {
            app.use(VueQueryPlugin, { queryClient: options.queryClient });
        } else if (!hasVueQuery) {
            app.use(VueQueryPlugin, { queryClient: createTruapiQueryClient() });
        }
    },
};

export function useRuntime(): TruapiRuntime<ResolvedChains> {
    const runtime = inject(RUNTIME_KEY, null);
    if (!runtime) {
        throw new Error(
            "product-sdk: install TruapiPlugin (app.use(TruapiPlugin, { config })) first",
        );
    }
    return runtime as TruapiRuntime<ResolvedChains>;
}
