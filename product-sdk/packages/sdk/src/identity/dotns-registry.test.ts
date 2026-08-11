// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// These tests cover the parts that don't need a chain: input validation, the
// error model, and the (still-unwired) write contract. The on-chain read path
// (createContract → dryRunCall → viem decode) is exercised against a live /
// forked Asset Hub, not here — replicating the contracts package's viem
// round-trip fake in the sdk package isn't worth the duplication.
import { describe, expect, test } from "vitest";
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { DotNsError } from "./dotns-errors.js";
import { registerDotNs, resolveDotNs, setDotNsRecord } from "./dotns-registry.js";

// Never reached on the validation path (resolveDotNs rejects before touching it).
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

    test("DotNsError implements the SdkError marker", () => {
        const e = new DotNsError("RegistryCall", "boom");
        expect(e.isSdkError).toBe(true);
        expect(e.source).toBe("dotns");
        expect(e.reason).toBe("RegistryCall");
    });

    test("write helpers throw a typed NotWired error (follow-up PR)", () => {
        expect(() => registerDotNs({ name: "alice.dot", owner: "5x" }, opts)).toThrow(DotNsError);
        expect(() => setDotNsRecord({ name: "alice.dot", address: "5y" }, opts)).toThrow(
            DotNsError,
        );
        try {
            registerDotNs({ name: "alice.dot", owner: "5x" }, opts);
        } catch (e) {
            expect((e as DotNsError).reason).toBe("NotWired");
        }
    });
});
