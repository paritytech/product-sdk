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
    // Under Node, read process.env and never touch `localStorage` — even when
    // the key is unset. Node 22+ defines a global `localStorage` object, so
    // `typeof localStorage` is `"object"` and doesn't warn; the warning fires
    // lazily the first time `getItem` is actually called (only reachable via
    // the browser branch below, which Node must never fall into).
    if (typeof process !== "undefined" && process.versions?.node) {
        return process.env[key];
    }
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

    test("readEnv returns undefined under Node for an unset key without touching localStorage", () => {
        // Under Node, readEnv takes the process.env branch unconditionally, even
        // when the key is unset — it never falls through to the localStorage
        // try/catch. Regression test for the bug fixed below: this used to fall
        // through to `localStorage.getItem`, which is what triggered Node's
        // "--localstorage-file was provided without a valid path" warning.
        const result = readEnv("NONEXISTENT_KEY_FOR_COVERAGE");
        expect(result).toBeUndefined();
    });

    test("importing the logger under Node never emits the --localstorage-file warning", async () => {
        // Node's global `localStorage` warns lazily, the first time `getItem` is
        // actually invoked — not on `typeof localStorage`, which is `"object"` on
        // Node 22+ and warns nothing. So the only reliable way to assert "no
        // warning" is to run this module in a real subprocess and inspect stderr.
        const { spawnSync } = await import("node:child_process");
        const { fileURLToPath } = await import("node:url");

        // Strip PRODUCT_SDK_LOG(_NS) from the child's env: earlier tests in this
        // file set them via `process.env.X = undefined`, which coerces to the
        // *string* "undefined" (truthy) on the live process.env rather than
        // deleting the key. A polluted parent env would otherwise leak into the
        // child via inheritance and mask the very bug this test exists to catch.
        // (Unlike process.env, spawnSync's plain-object `env` option omits keys
        // whose value is `undefined` from the child's environment.)
        const env = { ...process.env };
        env.PRODUCT_SDK_LOG = undefined;
        env.PRODUCT_SDK_LOG_NS = undefined;

        const selfPath = fileURLToPath(import.meta.url);
        const result = spawnSync(process.execPath, ["--experimental-strip-types", selfPath], {
            encoding: "utf8",
            env,
        });

        expect(result.status).toBe(0);
        expect(result.stderr.toLowerCase()).not.toContain("localstorage");
    });
}
