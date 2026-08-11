// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { DotNsError } from "./dotns-errors.js";
import {
    isDotNsAvailable,
    registerDotNs,
    resolveDotNs,
    reverseDotNs,
    setDotNsRecord,
} from "./dotns-registry.js";

// The runtime is never actually reached yet (calls short-circuit to NotWired),
// so a bare stub satisfies the type.
const opts = { runtime: {} as ContractRuntime };

describe("dotns registry surface", () => {
    test("resolveDotNs rejects an invalid name before any registry call", async () => {
        const r = await resolveDotNs("no", opts); // too short, no .dot
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toBeInstanceOf(DotNsError);
            expect(r.error.reason).toBe("InvalidName");
        }
    });

    test("resolveDotNs returns NotWired for a valid name (ABI pending)", async () => {
        const r = await resolveDotNs("alice.dot", opts);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("NotWired");
    });

    test("reverseDotNs returns NotWired (ABI pending)", async () => {
        const r = await reverseDotNs("5GrwvaEF...", opts);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("NotWired");
    });

    test("isDotNsAvailable propagates the underlying error", async () => {
        const r = await isDotNsAvailable("alice.dot", opts);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("NotWired");
    });

    test("DotNsError implements the SdkError marker", async () => {
        const r = await resolveDotNs("alice.dot", opts);
        if (!r.ok) {
            expect(r.error.isSdkError).toBe(true);
            expect(r.error.source).toBe("dotns");
        }
    });

    test("write helpers throw a typed NotWired error until the ABI lands", () => {
        expect(() => registerDotNs({ name: "alice.dot", owner: "5x" }, opts)).toThrow(DotNsError);
        expect(() => setDotNsRecord({ name: "alice.dot", address: "5y" }, opts)).toThrow(
            DotNsError,
        );
    });
});
