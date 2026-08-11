// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// These tests cover the parts that don't need a chain: input validation and the
// error model. The on-chain read/write paths (createContract → dryRunCall /
// prepare → viem encode/decode) are exercised against a live / forked Asset
// Hub, not here — replicating the contracts package's viem round-trip fake in
// the sdk package isn't worth the duplication.
import { describe, expect, test } from "vitest";
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { DotNsError } from "./dotns-errors.js";
import { prepareDotNsRegistration, resolveDotNs, setDotNsRecord } from "./dotns-registry.js";

// Never reached on the validation path (the calls reject before touching it).
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

    test("setDotNsRecord rejects an invalid name before any contract call", async () => {
        const r = await setDotNsRecord({ name: "no", address: "0x00" }, opts);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidName");
    });

    test("prepareDotNsRegistration rejects an invalid name before any contract call", async () => {
        const r = await prepareDotNsRegistration({ name: "no", owner: "0x00" }, opts);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidName");
    });

    test("DotNsError implements the SdkError marker", () => {
        const e = new DotNsError("RegistryCall", "boom");
        expect(e.isSdkError).toBe(true);
        expect(e.source).toBe("dotns");
        expect(e.reason).toBe("RegistryCall");
    });
});
