// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createRuntime, defineConfig, queryKeys } from "@parity/product-sdk-hooks-core";
import type { ChainDefinition } from "@parity/product-sdk-hooks-core";
import { type ReactNode, createElement } from "react";
import { describe, expect, it } from "vitest";
import { TruapiProvider } from "./context.js";
import { useLiveListQuery, useLiveQuery } from "./internal.js";

const config = defineConfig({
    chains: { test: { descriptor: {} as ChainDefinition, genesisHash: "0x11" as `0x${string}` } },
});

function setup() {
    const runtime = createRuntime(config);
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(TruapiProvider, { runtime, queryClient }, children);
    return { queryClient, wrapper };
}

/** A manually-driven subscription source standing in for a core watch*. */
function fakeSource<T>() {
    const listeners = new Set<{ onValue: (v: T) => void; onError: (e: unknown) => void }>();
    let attachCount = 0;
    let active = 0;
    return {
        get attachCount() {
            return attachCount;
        },
        get active() {
            return active;
        },
        push: (value: T) => {
            for (const l of listeners) l.onValue(value);
        },
        fail: (error: unknown) => {
            for (const l of listeners) l.onError(error);
        },
        attach: (onValue: (v: T) => void, onError: (e: unknown) => void) => {
            const listener = { onValue, onError };
            listeners.add(listener);
            attachCount++;
            active++;
            return () => {
                listeners.delete(listener);
                active--;
            };
        },
    };
}

describe("useLiveQuery", () => {
    it("bridges pushed values into the query cache", async () => {
        const { queryClient, wrapper } = setup();
        const source = fakeSource<number>();
        const key = queryKeys.blockNumber("test");

        const { result } = renderHook(
            () => useLiveQuery<number>({ queryKey: key, attach: source.attach }),
            { wrapper },
        );
        expect(result.current.isPending).toBe(true);

        act(() => source.push(41));
        await waitFor(() => expect(result.current.data).toBe(41));
        expect(result.current.isSuccess).toBe(true);
        expect(queryClient.getQueryData(key)).toBe(41);

        act(() => source.push(42));
        await waitFor(() => expect(result.current.data).toBe(42));
    });

    it("shares one subscription across hooks on the same key", async () => {
        const { wrapper } = setup();
        const source = fakeSource<number>();
        const key = queryKeys.blockNumber("test");
        const use = () => useLiveQuery<number>({ queryKey: key, attach: source.attach });

        const first = renderHook(use, { wrapper });
        const second = renderHook(use, { wrapper });
        await waitFor(() => expect(source.active).toBe(1));
        expect(source.attachCount).toBe(1);

        act(() => source.push(7));
        await waitFor(() => expect(first.result.current.data).toBe(7));
        await waitFor(() => expect(second.result.current.data).toBe(7));

        first.unmount();
        expect(source.active).toBe(1); // still one consumer
        second.unmount();
        expect(source.active).toBe(0); // last consumer released it
    });

    it("surfaces subscription errors while retaining the last value", async () => {
        const { wrapper } = setup();
        const source = fakeSource<number>();
        const { result } = renderHook(
            () =>
                useLiveQuery<number>({
                    queryKey: ["product-sdk", "err-test"],
                    attach: source.attach,
                }),
            { wrapper },
        );

        act(() => source.push(1));
        await waitFor(() => expect(result.current.data).toBe(1));

        act(() => source.fail(new Error("boom")));
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error?.message).toBe("boom");
        expect(result.current.data).toBe(1);
    });

    it("errors the query when the subscription fails before the first value", async () => {
        const { wrapper } = setup();
        const source = fakeSource<number>();
        const { result } = renderHook(
            () =>
                useLiveQuery<number>({
                    queryKey: ["product-sdk", "err-first"],
                    attach: source.attach,
                }),
            { wrapper },
        );
        act(() => source.fail(new Error("no host")));
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.data).toBeUndefined();
    });

    it("does not attach when disabled", () => {
        const { wrapper } = setup();
        const source = fakeSource<number>();
        renderHook(
            () =>
                useLiveQuery<number>({
                    queryKey: ["product-sdk", "disabled"],
                    attach: source.attach,
                    enabled: false,
                }),
            { wrapper },
        );
        expect(source.attachCount).toBe(0);
    });
});

describe("useLiveListQuery", () => {
    it("starts as an empty successful list and accumulates values", async () => {
        const { wrapper } = setup();
        const source = fakeSource<string>();
        const { result } = renderHook(
            () =>
                useLiveListQuery<string>({
                    queryKey: ["product-sdk", "list"],
                    attach: source.attach,
                    limit: 3,
                }),
            { wrapper },
        );

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual([]);

        act(() => {
            source.push("a");
            source.push("b");
            source.push("c");
            source.push("d");
        });
        await waitFor(() => expect(result.current.data).toEqual(["b", "c", "d"])); // bounded to 3

        act(() => result.current.clear());
        await waitFor(() => expect(result.current.data).toEqual([]));
    });
});
