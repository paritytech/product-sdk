// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createLazyStore, createStore } from "./store.js";

describe("createStore", () => {
    it("holds a value and notifies subscribers", () => {
        const store = createStore(1);
        const seen: number[] = [];
        const stop = store.subscribe((v) => seen.push(v));
        store.set(2);
        store.set((prev) => prev + 1);
        expect(store.get()).toBe(3);
        expect(seen).toEqual([2, 3]);
        stop();
        store.set(4);
        expect(seen).toEqual([2, 3]);
    });

    it("skips notification when the value is identical", () => {
        const store = createStore("a");
        const listener = vi.fn();
        store.subscribe(listener);
        store.set("a");
        expect(listener).not.toHaveBeenCalled();
    });
});

describe("createLazyStore", () => {
    it("starts on first subscriber and stops on last", () => {
        const stop = vi.fn();
        const start = vi.fn(() => stop);
        const store = createLazyStore(0, start);

        expect(start).not.toHaveBeenCalled();
        const a = store.subscribe(() => {});
        const b = store.subscribe(() => {});
        expect(start).toHaveBeenCalledTimes(1);

        a();
        expect(stop).not.toHaveBeenCalled();
        b();
        expect(stop).toHaveBeenCalledTimes(1);

        store.subscribe(() => {});
        expect(start).toHaveBeenCalledTimes(2);
    });

    it("double-unsubscribe does not double-stop", () => {
        const stop = vi.fn();
        const store = createLazyStore(0, () => stop);
        const a = store.subscribe(() => {});
        const b = store.subscribe(() => {});
        a();
        a();
        expect(stop).not.toHaveBeenCalled();
        b();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it("delivers values set by the starter", () => {
        const store = createLazyStore(0, (set) => {
            set(42);
            return () => {};
        });
        const seen: number[] = [];
        store.subscribe((v) => seen.push(v));
        expect(store.get()).toBe(42);
        expect(seen).toEqual([42]);
    });
});
