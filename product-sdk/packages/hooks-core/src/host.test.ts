// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
    inside: false,
    hostStorage: null as null | {
        readString: (k: string) => Promise<string | null>;
        writeString: (k: string, v: string) => Promise<void>;
        clear: (k: string) => Promise<void>;
    },
}));

vi.mock("@parity/product-sdk-host", async (importOriginal) => {
    const original = await importOriginal<typeof import("@parity/product-sdk-host")>();
    return {
        ...original,
        isInsideContainerSync: () => sdk.inside,
        isInsideContainer: () => Promise.resolve(sdk.inside),
        getHostLocalStorage: () => Promise.resolve(sdk.hostStorage),
        navigateTo: vi.fn(async (url: string) =>
            url.startsWith("blocked")
                ? { ok: false as const, error: new original.HostUnavailableError("navigate") }
                : { ok: true as const, value: undefined },
        ),
    };
});

import { createHostController, unwrapResult } from "./host.js";

function fakeLocalStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
    } as Storage;
}

beforeEach(() => {
    sdk.inside = false;
    sdk.hostStorage = null;
    vi.stubGlobal("localStorage", fakeLocalStorage());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("host detection", () => {
    it("resolves standalone", async () => {
        const host = createHostController();
        expect(host.mode.get()).toBe("unknown");
        await expect(host.detect()).resolves.toBe(false);
        expect(host.mode.get()).toBe("standalone");
    });

    it("resolves host mode synchronously when the sync marker is present", async () => {
        sdk.inside = true;
        const host = createHostController();
        expect(host.mode.get()).toBe("host");
        await expect(host.detect()).resolves.toBe(true);
    });

    it("memoizes detection", async () => {
        const host = createHostController();
        const [a, b] = await Promise.all([host.detect(), host.detect()]);
        expect(a).toBe(b);
    });
});

describe("unwrapResult", () => {
    it("returns the ok value", () => {
        expect(unwrapResult({ ok: true, value: 7 })).toBe(7);
    });

    it("throws the error", () => {
        const error = new Error("nope");
        expect(() => unwrapResult({ ok: false, error: error as never })).toThrow("nope");
    });
});

describe("storage fallback", () => {
    it("uses browser localStorage standalone", async () => {
        const host = createHostController();
        await host.storage.setJSON("k", { a: 1 });
        await expect(host.storage.getJSON("k")).resolves.toEqual({ a: 1 });
        await host.storage.remove("k");
        await expect(host.storage.getJSON("k")).resolves.toBeNull();
    });

    it("prefers host storage inside a container", async () => {
        sdk.inside = true;
        const backing = new Map<string, string>();
        sdk.hostStorage = {
            readString: async (k) => backing.get(k) ?? null,
            writeString: async (k, v) => void backing.set(k, v),
            clear: async (k) => void backing.delete(k),
        };
        const host = createHostController();
        await host.storage.setString("k", "v");
        expect(backing.get("k")).toBe("v");
        expect(globalThis.localStorage.getItem("k")).toBeNull();
    });
});

describe("one-shot wrappers", () => {
    it("navigate unwraps ok results", async () => {
        const host = createHostController();
        await expect(host.navigate("https://example.com")).resolves.toBeUndefined();
    });

    it("navigate throws err results", async () => {
        const host = createHostController();
        await expect(host.navigate("blocked://x")).rejects.toThrow();
    });
});
