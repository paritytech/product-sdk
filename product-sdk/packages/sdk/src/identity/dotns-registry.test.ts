// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// Contract paths run through `createFakeContractRuntime` from
// `@parity/product-sdk-contracts/testing`: the real codec, no chain. What these
// cannot cover is whether the deployed contracts behave as modelled here.
import type { AbiEntry, ContractRuntime } from "@parity/product-sdk-contracts";
import { createFakeContractRuntime, fakeDryRunResult } from "@parity/product-sdk-contracts/testing";
import { describe, expect, test } from "vitest";
import {
    DOTNS_POP_RULES_ABI,
    DOTNS_REGISTRAR_CONTROLLER_ABI,
    DOTNS_REGISTRY_ABI,
    DOTNS_RESOLVER_ABI,
    DOTNS_RESOLVER_WRITE_ABI,
    DOTNS_REVERSE_RESOLVER_ABI,
    PASEO_ASSETHUB_DOTNS,
} from "./dotns-abis.js";
import { DotNsError } from "./dotns-errors.js";
import {
    isDotNsAvailable,
    prepareDotNsRegistration,
    resolveDotNs,
    setDotNsRecord,
} from "./dotns-registry.js";

// Never reached on the validation path (the calls reject before touching it).
const opts = { runtime: {} as ContractRuntime };

const ALL_ABIS: AbiEntry[] = [
    ...DOTNS_REGISTRY_ABI,
    ...DOTNS_RESOLVER_ABI,
    ...DOTNS_REVERSE_RESOLVER_ABI,
    ...DOTNS_RESOLVER_WRITE_ABI,
    ...DOTNS_REGISTRAR_CONTROLLER_ABI,
    ...DOTNS_POP_RULES_ABI,
];

/** Unset pointer / unregistered owner. */
const ZERO = "0x0000000000000000000000000000000000000000";
/** Stand-in accounts. Distinct on purpose: a test must not pass by confusing them. */
const OWNER = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";

// The real defaults, because these tests leave the addresses out of `opts` and
// exercise the fallback path. Arbitrary values here would stop the
// reverse-resolver branch firing and the tests would pass for the wrong reason.
// See "honours the address overrides" for the opts path.
const FORWARD_RESOLVER = PASEO_ASSETHUB_DOTNS.resolver;
const REVERSE_RESOLVER = PASEO_ASSETHUB_DOTNS.reverseResolver;

/** A runtime whose view calls answer from `answers`, keyed by function name. */
function runtimeWith(answers: Record<string, unknown>) {
    return createFakeContractRuntime({
        abi: ALL_ABIS,
        onQuery: ({ functionName }) =>
            functionName && functionName in answers ? answers[functionName] : undefined,
    });
}

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

describe("resolveDotNs", () => {
    test("resolves a name that has a forward record", async () => {
        const runtime = runtimeWith({
            owner: OWNER,
            resolver: FORWARD_RESOLVER,
            addressOf: TARGET,
        });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r).toEqual({
            ok: true,
            value: { address: TARGET, name: "alice.dot", owner: OWNER },
        });
    });

    test("a node pointed at the reverse resolver is registered with no forward record", async () => {
        // The state of every name straight after registration.
        const runtime = runtimeWith({ owner: OWNER, resolver: REVERSE_RESOLVER });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r).toEqual({ ok: true, value: { name: "alice.dot", owner: OWNER } });
        // addressOf must not be attempted against the reverse resolver.
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("addressOf");
    });

    test("the reverse-resolver comparison ignores address casing", async () => {
        const runtime = runtimeWith({
            owner: OWNER,
            resolver: REVERSE_RESOLVER.toLowerCase(),
        });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r.ok && r.value?.address).toBeUndefined();
    });

    test("an unset resolver pointer is also registered with no forward record", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r).toEqual({ ok: true, value: { name: "alice.dot", owner: OWNER } });
    });

    test("a forward resolver holding an empty record has no address", async () => {
        const runtime = runtimeWith({
            owner: OWNER,
            resolver: FORWARD_RESOLVER,
            addressOf: ZERO,
        });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r).toEqual({ ok: true, value: { name: "alice.dot", owner: OWNER } });
    });

    test("a zero owner means unregistered, reported as null not as a record", async () => {
        const runtime = runtimeWith({ owner: ZERO, resolver: ZERO });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r).toEqual({ ok: true, value: null });
    });

    test("an unregistered name and a registered one are distinguishable", async () => {
        const unregistered = await resolveDotNs("alice.dot", {
            runtime: runtimeWith({ owner: ZERO, resolver: ZERO }),
        });
        const registered = await resolveDotNs("alice.dot", {
            runtime: runtimeWith({ owner: OWNER, resolver: REVERSE_RESOLVER }),
        });
        expect(unregistered.ok && unregistered.value).toBeNull();
        expect(registered.ok && registered.value).not.toBeNull();
    });

    test("honours the address overrides instead of the defaults", async () => {
        // Proves the branch above keys off `opts`, not off the hardcoded table.
        const customRegistry = "0x3333333333333333333333333333333333333333";
        const customReverse = "0x4444444444444444444444444444444444444444";
        const runtime = runtimeWith({ owner: OWNER, resolver: customReverse });
        const r = await resolveDotNs("alice.dot", {
            runtime,
            registryAddress: customRegistry,
            reverseResolverAddress: customReverse,
        });
        // Treated as "no forward record" because it matches the override.
        expect(r).toEqual({ ok: true, value: { name: "alice.dot", owner: OWNER } });
        expect(runtime.calls.every((c) => c.dest === customRegistry)).toBe(true);
    });

    test("a failing owner read is an error, not a guessed owner", async () => {
        const runtime = runtimeWith({
            owner: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
            resolver: FORWARD_RESOLVER,
            addressOf: TARGET,
        });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });
});

describe("isDotNsAvailable", () => {
    test("asks the registrar controller rather than inferring from resolution", async () => {
        const runtime = runtimeWith({ available: true });
        const r = await isDotNsAvailable("alice.dot", { runtime });
        expect(r).toEqual({ ok: true, value: true });
        expect(runtime.calls.map((c) => c.functionName)).toEqual(["available"]);
    });

    test("passes the bare label, without the .dot suffix", async () => {
        const runtime = runtimeWith({ available: true });
        await isDotNsAvailable("alice.dot", { runtime });
        expect(runtime.calls[0]?.args).toEqual(["alice"]);
    });

    test("an owned name with no forward record is not available", async () => {
        // This shape used to report `true`, costing the caller a commit fee.
        const runtime = runtimeWith({ available: false, owner: OWNER, resolver: ZERO });
        const r = await isDotNsAvailable("alice.dot", { runtime });
        expect(r).toEqual({ ok: true, value: false });
    });

    test("an invalid name is rejected before the controller call", async () => {
        const runtime = runtimeWith({ available: true });
        const r = await isDotNsAvailable("no", { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidName");
        expect(runtime.calls).toHaveLength(0);
    });
});

describe("setDotNsRecord", () => {
    test("moves the resolver pointer before writing the record", async () => {
        const runtime = runtimeWith({ resolver: REVERSE_RESOLVER });
        const r = await setDotNsRecord({ name: "alice.dot", address: TARGET }, { runtime });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toHaveLength(2);
        expect(runtime.calls.map((c) => c.functionName)).toEqual([
            "resolver",
            "setResolver",
            "setAddress",
        ]);
    });

    test("skips the pointer move when the node already points at the resolver", async () => {
        const runtime = runtimeWith({ resolver: FORWARD_RESOLVER });
        const r = await setDotNsRecord({ name: "alice.dot", address: TARGET }, { runtime });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toHaveLength(1);
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("setResolver");
    });

    test("the pointer move targets the forward resolver for the right node", async () => {
        const runtime = runtimeWith({ resolver: ZERO });
        await setDotNsRecord({ name: "alice.dot", address: TARGET }, { runtime });
        const setResolver = runtime.calls.find((c) => c.functionName === "setResolver");
        expect(setResolver?.args?.[1]).toBe(FORWARD_RESOLVER);
        const setAddress = runtime.calls.find((c) => c.functionName === "setAddress");
        expect(setAddress?.args?.[0]).toBe(setResolver?.args?.[0]);
    });

    test("a failing resolver read is an error", async () => {
        const runtime = runtimeWith({
            resolver: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await setDotNsRecord({ name: "alice.dot", address: TARGET }, { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });
});
