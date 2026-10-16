// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, VUE_QUERY_CLIENT, useQueryClient } from "@tanstack/vue-query";
import { createRuntime, defineConfig, queryKeys } from "@parity/product-sdk-hooks-core";
import { mount } from "@vue/test-utils";
import type { ChainDefinition } from "@parity/product-sdk-hooks-core";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import {
    TruapiPlugin,
    useAccounts,
    useConnect,
    useFormattedBalance,
    useHostMode,
    useHostStorage,
    useRuntime,
    useTheme,
} from "./index.js";
import { useLiveQuery } from "./internal.js";

const config = defineConfig({
    chains: { test: { descriptor: {} as ChainDefinition, genesisHash: "0x11" as `0x${string}` } },
});

function withSetup<T>(setup: () => T, runtime = createRuntime(config), queryClient?: QueryClient) {
    let result: T | undefined;
    const wrapper = mount(
        defineComponent({
            setup() {
                result = setup();
                return () => h("div");
            },
        }),
        {
            global: {
                plugins: [[TruapiPlugin, queryClient ? { runtime, queryClient } : { runtime }]],
            },
        },
    );
    if (result === undefined) throw new Error("setup did not run");
    return { result, wrapper };
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("TruapiPlugin / useRuntime", () => {
    it("provides the runtime", () => {
        const runtime = createRuntime(config);
        const { result } = withSetup(() => useRuntime(), runtime);
        expect(result).toBe(runtime);
    });

    it("installs a QueryClient when the app has none", () => {
        const { result } = withSetup(() => useQueryClient());
        expect(result).toBeInstanceOf(QueryClient);
    });

    it("prefers an explicit queryClient option", () => {
        const explicit = new QueryClient();
        const { result } = withSetup(() => useQueryClient(), createRuntime(config), explicit);
        expect(result).toBe(explicit);
    });

    it("reuses the app's QueryClient when VueQueryPlugin is already installed", () => {
        const appClient = new QueryClient();
        let seen: QueryClient | undefined;
        mount(
            defineComponent({
                setup() {
                    seen = useQueryClient();
                    return () => h("div");
                },
            }),
            {
                global: {
                    provide: { [VUE_QUERY_CLIENT]: appClient },
                    plugins: [[TruapiPlugin, { runtime: createRuntime(config) }]],
                },
            },
        );
        expect(seen).toBe(appClient);
    });
});

describe("host composables", () => {
    it("useHostMode settles on standalone in tests", async () => {
        const { result } = withSetup(() => useHostMode());
        await flush();
        expect(result.value).toBe("standalone");
    });

    it("useTheme falls back to the system scheme", () => {
        const { result } = withSetup(() => useTheme());
        expect(["light", "dark"]).toContain(result.value.variant);
        expect(result.value.source).toBe("system");
    });

    it("useHostStorage round-trips and updates the query cache", async () => {
        const client = new QueryClient();
        const { result } = withSetup(
            () => useHostStorage<{ n: number }>("vue-key"),
            createRuntime(config),
            client,
        );
        await flush();
        await result.set({ n: 9 });
        await flush();
        expect(result.data.value).toEqual({ n: 9 });
        expect(client.getQueryData(queryKeys.hostStorage("vue-key"))).toEqual({ n: 9 });
        await result.remove();
        await flush();
        expect(result.data.value).toBeNull();
    });
});

describe("account composables", () => {
    it("useAccounts connects to dev accounts standalone", async () => {
        const { result } = withSetup(() => useAccounts());
        expect(result.status.value).toBe("disconnected");
        await result.connect();
        expect(result.isConnected.value).toBe(true);
        expect(result.accounts.value.length).toBeGreaterThan(0);
        expect(result.selectedAccount.value).not.toBeNull();
    });

    it("useConnect exposes a named connect action with mutation state", async () => {
        const { result } = withSetup(() => useConnect());
        expect(result.status.value).toBe("idle");
        expect("mutate" in result).toBe(false);
        await result.connect();
        await flush();
        expect(result.status.value).toBe("success");
        expect(result.data.value?.length).toBeGreaterThan(0);
    });
});

describe("live queries", () => {
    it("bridges pushed values into the query cache and shares subscriptions", async () => {
        const client = new QueryClient();
        const listeners = new Set<(v: number) => void>();
        let attachCount = 0;
        const attach = (onValue: (v: number) => void) => {
            listeners.add(onValue);
            attachCount++;
            return () => listeners.delete(onValue);
        };
        const key = ["product-sdk", "vue-live-test"];

        const { result } = withSetup(
            () => ({
                a: useLiveQuery<number>({ queryKey: () => key, attach }),
                b: useLiveQuery<number>({ queryKey: () => key, attach }),
            }),
            createRuntime(config),
            client,
        );
        await flush();
        expect(attachCount).toBe(1); // shared

        for (const l of listeners) l(42);
        await flush();
        expect(result.a.data.value).toBe(42);
        expect(result.b.data.value).toBe(42);
        expect(client.getQueryData(key)).toBe(42);
    });
});

describe("format composables", () => {
    it("useFormattedBalance renders planck with decimals", () => {
        const { result } = withSetup(() =>
            useFormattedBalance(12_345_600_000n, { decimals: 10, symbol: "PAS" }),
        );
        expect(result.value).toContain("1.2");
        expect(result.value).toContain("PAS");
    });
});
