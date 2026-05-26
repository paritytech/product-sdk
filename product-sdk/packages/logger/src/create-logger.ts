// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { LEVEL_VALUES, getEffectiveLevel, state } from "./state.js";
import type { LogEntry, LogLevel, Logger } from "./types.js";

const CONSOLE_METHODS: Record<LogLevel, (...args: unknown[]) => void> = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
};

function emit(level: LogLevel, namespace: string, message: string, data?: unknown): void {
    if (LEVEL_VALUES[level] > getEffectiveLevel(namespace)) {
        return;
    }

    const entry: LogEntry = {
        level,
        namespace,
        message,
        data,
        timestamp: Date.now(),
    };

    if (state.handler) {
        state.handler(entry);
        return;
    }

    const prefix = `[${namespace}]`;
    if (data !== undefined) {
        CONSOLE_METHODS[level](prefix, message, data);
    } else {
        CONSOLE_METHODS[level](prefix, message);
    }
}

/**
 * Create a {@link Logger} bound to a namespace.
 *
 * The namespace is attached to every {@link LogEntry} the logger emits and is
 * what {@link LoggerConfig.namespaces} matches against. Convention is
 * `package:area` — e.g. `"signer:dev"`, `"chain-client"`.
 */
export function createLogger(namespace: string): Logger {
    return {
        error: (message: string, data?: unknown) => emit("error", namespace, message, data),
        warn: (message: string, data?: unknown) => emit("warn", namespace, message, data),
        info: (message: string, data?: unknown) => emit("info", namespace, message, data),
        debug: (message: string, data?: unknown) => emit("debug", namespace, message, data),
    };
}

if (import.meta.vitest) {
    const { test, expect, describe, beforeEach } = import.meta.vitest;
    const { configure } = await import("./configure.js");
    const { resetState } = await import("./state.js");

    beforeEach(() => resetState());

    describe("createLogger", () => {
        test("error and warn are emitted by default", () => {
            const entries: LogEntry[] = [];
            configure({ handler: (e) => entries.push(e) });
            const log = createLogger("test");
            log.error("err");
            log.warn("wrn");
            log.info("inf");
            log.debug("dbg");
            expect(entries.map((e) => e.level)).toEqual(["error", "warn"]);
        });

        test("debug level shows all", () => {
            const entries: LogEntry[] = [];
            configure({ level: "debug", handler: (e) => entries.push(e) });
            const log = createLogger("test");
            log.error("e");
            log.warn("w");
            log.info("i");
            log.debug("d");
            expect(entries).toHaveLength(4);
        });

        test("namespace filtering restricts elevated level", () => {
            const entries: LogEntry[] = [];
            configure({
                level: "debug",
                namespaces: ["keys"],
                handler: (e) => entries.push(e),
            });
            const keysLog = createLogger("keys");
            const otherLog = createLogger("chain-client");
            keysLog.debug("yes");
            otherLog.debug("no");
            otherLog.error("yes");
            expect(entries.map((e) => `${e.namespace}:${e.level}`)).toEqual([
                "keys:debug",
                "chain-client:error",
            ]);
        });

        test("data is included in entry", () => {
            const entries: LogEntry[] = [];
            configure({ handler: (e) => entries.push(e) });
            const log = createLogger("test");
            log.error("msg", { key: "val" });
            expect(entries[0].data).toEqual({ key: "val" });
        });

        test("entry includes timestamp", () => {
            const entries: LogEntry[] = [];
            configure({ handler: (e) => entries.push(e) });
            const log = createLogger("test");
            const before = Date.now();
            log.error("msg");
            expect(entries[0].timestamp).toBeGreaterThanOrEqual(before);
        });

        test("info level shows info, warn, error but not debug", () => {
            const entries: LogEntry[] = [];
            configure({ level: "info", handler: (e) => entries.push(e) });
            const log = createLogger("test");
            log.error("e");
            log.warn("w");
            log.info("i");
            log.debug("d");
            expect(entries.map((e) => e.level)).toEqual(["error", "warn", "info"]);
        });

        test("configure overrides previous config", () => {
            const entries: LogEntry[] = [];
            configure({ level: "debug", handler: (e) => entries.push(e) });
            const log = createLogger("test");
            log.debug("before");
            configure({ level: "error", handler: (e) => entries.push(e) });
            log.debug("after");
            log.error("visible");
            expect(entries.map((e) => e.message)).toEqual(["before", "visible"]);
        });

        test("empty namespaces array applies level globally", () => {
            const entries: LogEntry[] = [];
            configure({ level: "debug", namespaces: [], handler: (e) => entries.push(e) });
            const log = createLogger("any-package");
            log.debug("visible");
            expect(entries).toHaveLength(1);
        });

        test("falls back to console when no handler configured", () => {
            const calls: unknown[][] = [];
            const origWarn = CONSOLE_METHODS.warn;
            CONSOLE_METHODS.warn = (...args: unknown[]) => calls.push(args);
            try {
                // No handler after resetState — should hit the default console path
                const log = createLogger("test");
                log.warn("hello");
                expect(calls).toHaveLength(1);
                expect(calls[0]).toEqual(["[test]", "hello"]);
            } finally {
                CONSOLE_METHODS.warn = origWarn;
            }
        });

        test("console fallback includes data when provided", () => {
            const calls: unknown[][] = [];
            const origError = CONSOLE_METHODS.error;
            CONSOLE_METHODS.error = (...args: unknown[]) => calls.push(args);
            try {
                const log = createLogger("test");
                log.error("msg", { key: "val" });
                expect(calls).toHaveLength(1);
                expect(calls[0]).toEqual(["[test]", "msg", { key: "val" }]);
            } finally {
                CONSOLE_METHODS.error = origError;
            }
        });
    });
}
