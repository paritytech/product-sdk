// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createRuntime, defineConfig } from "@parity/product-sdk-hooks-core";
import { mount } from "@vue/test-utils";
import type { ChainDefinition } from "@parity/product-sdk-hooks-core";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import {
    TruapiPlugin,
    useHostChainInfo,
    useHostConnectionStatus,
    useHostInfo,
    useLocale,
    usePickContact,
    usePocketCards,
    useProductContext,
} from "./index.js";

const config = defineConfig({
    chains: { test: { descriptor: {} as ChainDefinition, hostChain: "AssetHub" } },
});

function withSetup<T>(setup: () => T) {
    let result: T | undefined;
    mount(
        defineComponent({
            setup() {
                result = setup();
                return () => h("div");
            },
        }),
        { global: { plugins: [[TruapiPlugin, { runtime: createRuntime(config) }]] } },
    );
    if (result === undefined) throw new Error("setup did not run");
    return result;
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("host capability composables standalone", () => {
    it("useLocale follows navigator.language", () => {
        const locale = withSetup(() => useLocale());
        expect(locale.value.source).toBe("navigator");
        expect(locale.value.languageTag).toBeTruthy();
    });

    it("useHostConnectionStatus is disconnected", async () => {
        const status = withSetup(() => useHostConnectionStatus());
        await flush();
        expect(status.value).toBe("disconnected");
    });

    it("useHostInfo / useProductContext / useHostChainInfo resolve null", async () => {
        const result = withSetup(() => ({
            info: useHostInfo(),
            context: useProductContext(),
            chains: useHostChainInfo(["AssetHub"]),
        }));
        await flush(50);
        expect(result.info.isSuccess.value).toBe(true);
        expect(result.info.data.value).toBeNull();
        expect(result.context.data.value).toBeNull();
        expect(result.chains.data.value).toBeNull();
    });

    it("usePocketCards errors and usePickContact rejects standalone", async () => {
        const result = withSetup(() => ({
            cards: usePocketCards({ query: { retry: false } }),
            pick: usePickContact(),
        }));
        await flush(60);
        expect(result.cards.isError.value).toBe(true);
        expect(result.cards.error.value?.name).toBe("HostUnavailableError");
        await expect(result.pick.pick()).rejects.toMatchObject({ name: "HostUnavailableError" });
    });
});
