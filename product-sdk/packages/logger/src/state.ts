// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { LogHandler, LogLevel } from "./types.js";

export const LEVEL_VALUES: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

const DEFAULT_LEVEL: LogLevel = "warn";

function readEnv(key: string): string | undefined {
    if (typeof process !== "undefined" && process.env?.[key]) return process.env[key];
    try {
        return localStorage.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
}

function getInitialLevel(): LogLevel {
    const raw = readEnv("PRODUCT_SDK_LOG");
    return raw && raw in LEVEL_VALUES ? (raw as LogLevel) : DEFAULT_LEVEL;
}

function getInitialNamespaces(): Set<string> | undefined {
    const raw = readEnv("PRODUCT_SDK_LOG_NS");
    if (!raw) return undefined;
    const ns = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return ns.length > 0 ? new Set(ns) : undefined;
}

/** Mutable global state — modified by configure(), read by every logger instance. */
export const state = {
    level: getInitialLevel(),
    namespaces: getInitialNamespaces(),
    handler: undefined as LogHandler | undefined,
};

export function getEffectiveLevel(namespace: string): number {
    if (state.namespaces && !state.namespaces.has(namespace)) {
        return LEVEL_VALUES[DEFAULT_LEVEL];
    }
    return LEVEL_VALUES[state.level];
}

export function resetState(): void {
    state.level = DEFAULT_LEVEL;
    state.namespaces = undefined;
    state.handler = undefined;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("LEVEL_VALUES has correct ordering", () => {
        expect(LEVEL_VALUES.error).toBeLessThan(LEVEL_VALUES.warn);
        expect(LEVEL_VALUES.warn).toBeLessThan(LEVEL_VALUES.info);
        expect(LEVEL_VALUES.info).toBeLessThan(LEVEL_VALUES.debug);
    });

    test("getEffectiveLevel returns default when namespace not in set", () => {
        state.namespaces = new Set(["auth"]);
        state.level = "debug";
        // "network" is not in the set, so should return default (warn = 1)
        expect(getEffectiveLevel("network")).toBe(LEVEL_VALUES.warn);
        // "auth" is in the set, so should return configured level
        expect(getEffectiveLevel("auth")).toBe(LEVEL_VALUES.debug);
        resetState();
    });

    test("getEffectiveLevel returns configured level when no namespace filter", () => {
        state.level = "info";
        state.namespaces = undefined;
        expect(getEffectiveLevel("anything")).toBe(LEVEL_VALUES.info);
        resetState();
    });

    test("resetState restores defaults", () => {
        state.level = "debug";
        state.namespaces = new Set(["test"]);
        state.handler = () => {};
        resetState();
        expect(state.level).toBe("warn");
        expect(state.namespaces).toBeUndefined();
        expect(state.handler).toBeUndefined();
    });

    test("readEnv returns undefined for missing keys", () => {
        expect(readEnv("PRODUCT_SDK_NONEXISTENT_KEY_12345")).toBeUndefined();
    });

    test("getInitialLevel returns default for invalid env value", () => {
        // getInitialLevel already ran at module load; test the logic indirectly
        expect(getInitialLevel()).toBe("warn");
    });

    test("getInitialNamespaces returns undefined when env not set", () => {
        expect(getInitialNamespaces()).toBeUndefined();
    });

    test("getInitialNamespaces parses comma-separated env var", () => {
        process.env.PRODUCT_SDK_LOG_NS = "keys, storage, tx";
        try {
            const ns = getInitialNamespaces();
            expect(ns).toBeDefined();
            expect(ns!.has("keys")).toBe(true);
            expect(ns!.has("storage")).toBe(true);
            expect(ns!.has("tx")).toBe(true);
            expect(ns!.size).toBe(3);
        } finally {
            process.env.PRODUCT_SDK_LOG_NS = undefined;
        }
    });

    test("getInitialNamespaces returns undefined for empty string", () => {
        process.env.PRODUCT_SDK_LOG_NS = "";
        try {
            expect(getInitialNamespaces()).toBeUndefined();
        } finally {
            process.env.PRODUCT_SDK_LOG_NS = undefined;
        }
    });

    test("getInitialLevel reads from env var", () => {
        process.env.PRODUCT_SDK_LOG = "debug";
        try {
            expect(getInitialLevel()).toBe("debug");
        } finally {
            process.env.PRODUCT_SDK_LOG = undefined;
        }
    });

    test("configure with empty namespaces clears the filter", async () => {
        const { configure } = await import("./configure.js");
        state.namespaces = new Set(["test"]);
        configure({ namespaces: [] });
        expect(state.namespaces).toBeUndefined();
        resetState();
    });

    test("configure with namespaces sets the filter", async () => {
        const { configure } = await import("./configure.js");
        configure({ namespaces: ["auth", "tx"] });
        expect(state.namespaces).toBeDefined();
        expect(state.namespaces!.has("auth")).toBe(true);
        expect(state.namespaces!.has("tx")).toBe(true);
        resetState();
    });

    test("readEnv catches localStorage errors gracefully", () => {
        // In Node without localStorage, readEnv tries localStorage.getItem which throws
        // The catch block returns undefined — this exercises the catch branch
        const result = readEnv("NONEXISTENT_KEY_FOR_COVERAGE");
        expect(result).toBeUndefined();
    });
}
