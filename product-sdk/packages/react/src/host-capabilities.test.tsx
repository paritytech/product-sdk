// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { renderHook, waitFor } from "@testing-library/react";
import { createRuntime, defineConfig } from "@parity/product-sdk-hooks-core";
import type { ChainDefinition } from "@parity/product-sdk-hooks-core";
import { type ReactNode, createElement } from "react";
import { describe, expect, it } from "vitest";
import {
    TruapiProvider,
    useHostChainInfo,
    useHostConnectionStatus,
    useHostInfo,
    useHostStorage,
    useLocale,
    usePickContact,
    usePocketCards,
    usePreimage,
    useProductContext,
    useRingVrfKeys,
    useWorkerOperation,
} from "./index.js";

const config = defineConfig({
    chains: { test: { descriptor: {} as ChainDefinition, hostChain: "AssetHub" } },
});

function wrapper({ children }: { children: ReactNode }) {
    return createElement(TruapiProvider, { runtime: createRuntime(config) }, children);
}

describe("host capability hooks standalone", () => {
    it("useLocale follows navigator.language", () => {
        const { result } = renderHook(() => useLocale(), { wrapper });
        expect(result.current.source).toBe("navigator");
        expect(result.current.languageTag).toBeTruthy();
    });

    it("useHostConnectionStatus is disconnected", async () => {
        const { result } = renderHook(() => useHostConnectionStatus(), { wrapper });
        await waitFor(() => expect(result.current).toBe("disconnected"));
    });

    it("useHostInfo / useProductContext / useHostChainInfo resolve null", async () => {
        const { result } = renderHook(
            () => ({
                info: useHostInfo(),
                context: useProductContext(),
                chains: useHostChainInfo(["AssetHub"]),
            }),
            { wrapper },
        );
        await waitFor(() => expect(result.current.info.isSuccess).toBe(true));
        await waitFor(() => expect(result.current.context.isSuccess).toBe(true));
        await waitFor(() => expect(result.current.chains.isSuccess).toBe(true));
        expect(result.current.info.data).toBeNull();
        expect(result.current.context.data).toBeNull();
        expect(result.current.chains.data).toBeNull();
    });

    it("usePreimage stays disabled without a key and errors standalone with one", async () => {
        const { result: disabled } = renderHook(() => usePreimage(undefined), { wrapper });
        expect(disabled.current.fetchStatus).toBe("idle");
        const { result } = renderHook(() => usePreimage("0x00"), { wrapper });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error?.name).toBe("HostUnavailableError");
    });

    it("useRingVrfKeys errors with HostUnavailableError standalone", async () => {
        // Standalone the query errors immediately; disable TanStack's default
        // exponential retry so the assertion doesn't wait through three attempts.
        const { result } = renderHook(
            () => useRingVrfKeys(undefined, { query: { retry: false } }),
            {
                wrapper,
            },
        );
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error?.name).toBe("HostUnavailableError");
    });

    it("usePocketCards errors with HostUnavailableError standalone", async () => {
        const { result } = renderHook(() => usePocketCards({ query: { retry: false } }), {
            wrapper,
        });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error?.name).toBe("HostUnavailableError");
    });

    it("usePickContact and useWorkerOperation reject standalone", async () => {
        const { result } = renderHook(
            () => ({ pick: usePickContact(), worker: useWorkerOperation() }),
            {
                wrapper,
            },
        );
        await expect(result.current.pick.pick()).rejects.toMatchObject({
            name: "HostUnavailableError",
        });
        await expect(result.current.worker.run(async () => 1)).rejects.toMatchObject({
            name: "HostUnavailableError",
        });
    });

    it("useHostStorage is live: a value written elsewhere is picked up", async () => {
        const backing = new Map<string, string>();
        const fakeStorage = {
            getItem: (k: string) => backing.get(k) ?? null,
            setItem: (k: string, v: string) => void backing.set(k, v),
            removeItem: (k: string) => void backing.delete(k),
        };
        Object.defineProperty(globalThis, "localStorage", {
            value: fakeStorage,
            configurable: true,
        });
        const { result } = renderHook(() => useHostStorage<{ n: number }>("live-key"), { wrapper });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toBeNull();
        backing.set("live-key", JSON.stringify({ n: 7 }));
        globalThis.dispatchEvent(new StorageEvent("storage", { key: "live-key" }));
        await waitFor(() => expect(result.current.data).toEqual({ n: 7 }));
    });
});
