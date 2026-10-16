// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createRuntime, defineConfig, queryKeys } from "@parity/product-sdk-hooks-core";
import type { ChainDefinition } from "@parity/product-sdk-hooks-core";
import { type ReactNode, createElement } from "react";
import { describe, expect, it } from "vitest";
import {
    TruapiProvider,
    useAccounts,
    useConnect,
    useFormattedBalance,
    useHostMode,
    useHostStorage,
    useIsHost,
    useRuntime,
    useSelectedAccount,
    useTheme,
} from "./index.js";

const config = defineConfig({
    chains: { test: { descriptor: {} as ChainDefinition, genesisHash: "0x11" as `0x${string}` } },
});

function wrapperFor(runtime = createRuntime(config), queryClient?: QueryClient) {
    return ({ children }: { children: ReactNode }) =>
        createElement(
            TruapiProvider,
            queryClient ? { runtime, queryClient } : { runtime },
            children,
        );
}

describe("TruapiProvider / useRuntime", () => {
    it("throws without a provider", () => {
        expect(() => renderHook(() => useRuntime())).toThrow(/TruapiProvider/);
    });

    it("provides the runtime", () => {
        const runtime = createRuntime(config);
        const { result } = renderHook(() => useRuntime(), { wrapper: wrapperFor(runtime) });
        expect(result.current).toBe(runtime);
    });

    it("provides its own QueryClient when the app has none", () => {
        const { result } = renderHook(() => useQueryClient(), { wrapper: wrapperFor() });
        expect(result.current).toBeInstanceOf(QueryClient);
    });

    it("reuses the app's QueryClient when rendered under a QueryClientProvider", () => {
        const appClient = new QueryClient();
        const runtime = createRuntime(config);
        const wrapper = ({ children }: { children: ReactNode }) =>
            createElement(
                QueryClientProvider,
                { client: appClient },
                createElement(TruapiProvider, { runtime }, children),
            );
        const { result } = renderHook(() => useQueryClient(), { wrapper });
        expect(result.current).toBe(appClient);
    });

    it("prefers an explicit queryClient prop", () => {
        const explicit = new QueryClient();
        const { result } = renderHook(() => useQueryClient(), {
            wrapper: wrapperFor(createRuntime(config), explicit),
        });
        expect(result.current).toBe(explicit);
    });
});

describe("host hooks", () => {
    it("useHostMode settles on standalone in tests", async () => {
        const { result } = renderHook(() => useHostMode(), { wrapper: wrapperFor() });
        await waitFor(() => expect(result.current).toBe("standalone"));
    });

    it("useIsHost is false standalone", async () => {
        const { result } = renderHook(() => useIsHost(), { wrapper: wrapperFor() });
        await waitFor(() => expect(result.current).toBe(false));
    });

    it("useTheme falls back to the system scheme", () => {
        const { result } = renderHook(() => useTheme(), { wrapper: wrapperFor() });
        expect(["light", "dark"]).toContain(result.current.variant);
        expect(result.current.source).toBe("system");
    });

    it("useHostStorage round-trips and updates the query cache", async () => {
        const client = new QueryClient();
        const { result } = renderHook(() => useHostStorage<{ n: number }>("test-key"), {
            wrapper: wrapperFor(createRuntime(config), client),
        });
        await waitFor(() => expect(result.current.isPending).toBe(false));
        await act(() => result.current.set({ n: 5 }));
        await waitFor(() => expect(result.current.data).toEqual({ n: 5 }));
        expect(client.getQueryData(queryKeys.hostStorage("test-key"))).toEqual({ n: 5 });
        await act(() => result.current.remove());
        await waitFor(() => expect(result.current.data).toBeNull());
    });
});

describe("account hooks", () => {
    it("useAccounts connects to dev accounts standalone", async () => {
        const wrapper = wrapperFor();
        const { result } = renderHook(() => useAccounts(), { wrapper });
        expect(result.current.status).toBe("disconnected");

        await act(async () => {
            await result.current.connect();
        });

        await waitFor(() => expect(result.current.isConnected).toBe(true));
        expect(result.current.accounts.length).toBeGreaterThan(0);
        expect(result.current.selectedAccount).not.toBeNull();
    });

    it("useConnect exposes a named connect action with mutation state", async () => {
        const { result } = renderHook(() => useConnect(), { wrapper: wrapperFor() });
        expect(result.current.status).toBe("idle");
        expect("mutate" in result.current).toBe(false);
        await act(async () => {
            await result.current.connect();
        });
        await waitFor(() => expect(result.current.status).toBe("success"));
        expect(result.current.data?.length).toBeGreaterThan(0);
        act(() => result.current.reset());
        await waitFor(() => expect(result.current.status).toBe("idle"));
    });

    it("useSelectedAccount tracks selection across hooks sharing a runtime", async () => {
        const runtime = createRuntime(config);
        const wrapper = wrapperFor(runtime);
        const accounts = renderHook(() => useAccounts(), { wrapper });
        const selected = renderHook(() => useSelectedAccount(), { wrapper });

        await act(async () => {
            await accounts.result.current.connect();
        });
        await waitFor(() => expect(selected.result.current).not.toBeNull());

        const other = accounts.result.current.accounts[1];
        if (!other) throw new Error("expected several dev accounts");
        act(() => {
            accounts.result.current.select(other.address);
        });
        await waitFor(() => expect(selected.result.current?.address).toBe(other.address));
    });
});

describe("format hooks", () => {
    it("useFormattedBalance renders planck with decimals", () => {
        const { result } = renderHook(
            () => useFormattedBalance(12_345_600_000n, { decimals: 10, symbol: "PAS" }),
            { wrapper: wrapperFor() },
        );
        expect(result.current).toContain("1.2");
        expect(result.current).toContain("PAS");
    });

    it("returns empty string for missing values", () => {
        const { result } = renderHook(() => useFormattedBalance(undefined), {
            wrapper: wrapperFor(),
        });
        expect(result.current).toBe("");
    });
});
