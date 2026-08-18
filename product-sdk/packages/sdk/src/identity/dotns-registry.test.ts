// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// Contract paths run through `createFakeContractRuntime` from
// `@parity/product-sdk-contracts/testing`: the real codec, no chain. What these
// cannot cover is whether the deployed contracts behave as modelled here.
import {
    type AbiEntry,
    type ContractRuntime,
    QUERY_FALLBACK_ORIGIN,
} from "@parity/product-sdk-contracts";
import { createFakeContractRuntime, fakeDryRunResult } from "@parity/product-sdk-contracts/testing";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { describe, expect, test } from "vitest";
import {
    DOTNS_POP_RULES_ABI,
    DOTNS_REGISTRAR_CONTROLLER_ABI,
    DOTNS_REGISTRY_ABI,
    DOTNS_RESOLVER_ABI,
    DOTNS_RESOLVER_WRITE_ABI,
    DOTNS_REVERSE_RESOLVER_ABI,
    PASEO_ASSETHUB_DOTNS,
    POP_STATUS,
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

/** Any SS58 account. The writes only need one to dry-run against. */
const SIGNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as const;

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
        const r = await setDotNsRecord(
            { name: "alice.dot", address: TARGET },
            { runtime, origin: SIGNER },
        );
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
        const r = await setDotNsRecord(
            { name: "alice.dot", address: TARGET },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toHaveLength(1);
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("setResolver");
    });

    test("the pointer move targets the forward resolver for the right node", async () => {
        const runtime = runtimeWith({ resolver: ZERO });
        await setDotNsRecord({ name: "alice.dot", address: TARGET }, { runtime, origin: SIGNER });
        const setResolver = runtime.calls.find((c) => c.functionName === "setResolver");
        expect(setResolver?.args?.[1]).toBe(FORWARD_RESOLVER);
        const setAddress = runtime.calls.find((c) => c.functionName === "setAddress");
        expect(setAddress?.args?.[0]).toBe(setResolver?.args?.[0]);
    });

    test("a failing resolver read is an error", async () => {
        const runtime = runtimeWith({
            resolver: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await setDotNsRecord(
            { name: "alice.dot", address: TARGET },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });
});

describe("origin", () => {
    test("reads pass the pallet-revive fallback rather than leaving it unset", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("alice.dot", { runtime });
        // Explicit, so the contracts layer does not warn once per query.
        expect(runtime.calls.every((c) => c.origin === QUERY_FALLBACK_ORIGIN)).toBe(true);
    });

    test("reads use opts.origin when given", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("alice.dot", { runtime, origin: SIGNER });
        expect(runtime.calls.every((c) => c.origin === SIGNER)).toBe(true);
    });

    test("setDotNsRecord dry-runs as the caller, not the fallback account", async () => {
        const runtime = runtimeWith({ resolver: REVERSE_RESOLVER });
        await setDotNsRecord({ name: "alice.dot", address: TARGET }, { runtime, origin: SIGNER });
        const writes = runtime.calls.filter((c) =>
            ["setResolver", "setAddress"].includes(c.functionName ?? ""),
        );
        expect(writes).toHaveLength(2);
        expect(writes.every((c) => c.origin === SIGNER)).toBe(true);
        expect(writes.every((c) => c.origin !== QUERY_FALLBACK_ORIGIN)).toBe(true);
    });

    test("setDotNsRecord without an origin fails before any call", async () => {
        const runtime = runtimeWith({ resolver: REVERSE_RESOLVER });
        const r = await setDotNsRecord({ name: "alice.dot", address: TARGET }, { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("MissingOrigin");
        expect(runtime.calls).toHaveLength(0);
    });

    test("prepareDotNsRegistration without an origin fails before any call", async () => {
        const runtime = runtimeWith({});
        const r = await prepareDotNsRegistration({ name: "alice.dot", owner: OWNER }, { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("MissingOrigin");
        expect(runtime.calls).toHaveLength(0);
    });

    test("prepareDotNsRegistration dry-runs every call as the caller", async () => {
        const runtime = runtimeWith({
            makeCommitment: `0x${"ab".repeat(32)}`,
            price: 1000n,
            minCommitmentAge: 60n,
            maxCommitmentAge: 86400n,
        });
        await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, origin: SIGNER },
        );
        expect(runtime.calls.length).toBeGreaterThan(0);
        expect(runtime.calls.every((c) => c.origin === SIGNER)).toBe(true);
    });
});

describe("prepareDotNsRegistration", () => {
    /** PopRules metadata: eligible NoStatus owner unless overridden. */
    const quote = (over: Partial<Record<string, unknown>> = {}) => ({
        price: 1000n,
        status: POP_STATUS.NoStatus,
        userStatus: POP_STATUS.NoStatus,
        message: "Available to all",
        ...over,
    });

    const happy = (over: Record<string, unknown> = {}) =>
        runtimeWith({
            makeCommitment: `0x${"ab".repeat(32)}`,
            priceWithoutCheck: quote(),
            transferFloor: 0n,
            minCommitmentAge: 60n,
            maxCommitmentAge: 86400n,
            ...over,
        });

    const REG = { name: "alice.dot", owner: OWNER };
    const withSigner = (runtime: ReturnType<typeof runtimeWith>) => ({ runtime, origin: SIGNER });

    test("does not dry-run register up front", async () => {
        // register consumes the commitment, so preparing it before commitCall
        // lands reverts with CommitmentNotFound.
        const runtime = happy();
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok).toBe(true);
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("register");
        expect(runtime.calls.map((c) => c.functionName)).toContain("commit");
    });

    test("returns a thunk that builds the register call later", async () => {
        const runtime = happy();
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        runtime.reset();
        const later = await r.value.prepareRegisterCall();
        expect(later.ok).toBe(true);
        expect(runtime.calls.map((c) => c.functionName)).toContain("register");
    });

    test("prices from priceWithoutCheck, not from price", async () => {
        const runtime = happy();
        await prepareDotNsRegistration(REG, withSigner(runtime));
        const names = runtime.calls.map((c) => c.functionName);
        expect(names).toContain("priceWithoutCheck");
        expect(names).not.toContain("price");
    });

    test("a governance-reserved label fails before the commit is prepared", async () => {
        const runtime = happy({
            priceWithoutCheck: quote({
                status: POP_STATUS.Reserved,
                message: "Reserved for Governance",
            }),
        });
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("NameReserved");
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("commit");
    });

    test("an owner below the required tier fails before the commit is prepared", async () => {
        const runtime = happy({
            priceWithoutCheck: quote({
                status: POP_STATUS.PopFull,
                userStatus: POP_STATUS.NoStatus,
                message: "Requires Full personhood verification",
            }),
        });
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("OwnerStatusInsufficient");
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("commit");
    });

    test("a verified owner meeting the tier is accepted", async () => {
        const runtime = happy({
            priceWithoutCheck: quote({
                status: POP_STATUS.PopFull,
                userStatus: POP_STATUS.PopFull,
                price: 0n,
            }),
        });
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.price).toBe(0n);
    });

    test("the direct path skips the friction read", async () => {
        // SIGNER derives to a different H160 than OWNER, so force the direct
        // case by registering to the payer's own address.
        const payer = ss58ToH160(SIGNER);
        const runtime = happy();
        await prepareDotNsRegistration({ name: "alice.dot", owner: payer }, withSigner(runtime));
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("transferFloor");
    });

    test("a cross-payer registration charges the friction floor when it is higher", async () => {
        const runtime = happy({ priceWithoutCheck: quote({ price: 10n }), transferFloor: 5000n });
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.price).toBe(5000n);
    });

    test("the register value is re-quoted, not the stale prepare-time price", async () => {
        let current = 1000n;
        const runtime = createFakeContractRuntime({
            abi: ALL_ABIS,
            onQuery: ({ functionName }) => {
                if (functionName === "makeCommitment") return `0x${"ab".repeat(32)}`;
                if (functionName === "priceWithoutCheck") return quote({ price: current });
                if (functionName === "transferFloor") return 0n;
                if (functionName === "minCommitmentAge") return 60n;
                if (functionName === "maxCommitmentAge") return 86400n;
                return undefined;
            },
        });
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok && r.value.price).toBe(1000n);
        if (!r.ok) return;

        current = 7777n; // price moves during the mandatory wait
        runtime.reset();
        await r.value.prepareRegisterCall();
        const register = runtime.calls.find((c) => c.functionName === "register");
        expect(register?.value).toBe(7777n);
    });

    test("a failing commitment-window read is an error, not a zero window", async () => {
        const runtime = happy({
            minCommitmentAge: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await prepareDotNsRegistration(REG, withSigner(runtime));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });
});

describe("error causes", () => {
    // The contracts package surfaces a dispatch payload on a failed query and a
    // typed ContractError from a failed prepare, so callers can tell "not the
    // owner" from "node missing" from "RPC down". Collapsing both to a bare
    // string loses that, which is what these pin.
    const FAILURE = { type: "ContractTrapped" } as const;

    test("a failed read carries the dispatch payload", async () => {
        const runtime = runtimeWith({ owner: fakeDryRunResult({ failure: FAILURE }) });
        const r = await resolveDotNs("alice.dot", { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.cause).toEqual(FAILURE);
    });

    test("a reverting write carries the ContractError, with its decoded reason", async () => {
        const runtime = runtimeWith({
            resolver: FORWARD_RESOLVER,
            setAddress: fakeDryRunResult({ revert: "Unauthorised" }),
        });
        const r = await setDotNsRecord(
            { name: "alice.dot", address: TARGET },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.cause).toBeDefined();
            expect(JSON.stringify(r.error.cause)).toContain("Unauthorised");
        }
    });

    test("a failed availability read carries its payload", async () => {
        const runtime = runtimeWith({ available: fakeDryRunResult({ failure: FAILURE }) });
        const r = await isDotNsAvailable("alice.dot", { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.cause).toEqual(FAILURE);
    });

    test("a failed pricing read carries its payload", async () => {
        const runtime = runtimeWith({
            makeCommitment: `0x${"ab".repeat(32)}`,
            priceWithoutCheck: fakeDryRunResult({ failure: FAILURE }),
            minCommitmentAge: 60n,
            maxCommitmentAge: 86400n,
        });
        const r = await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.cause).toEqual(FAILURE);
    });
});

describe("subnames", () => {
    test("a subname resolves", async () => {
        const runtime = runtimeWith({
            owner: OWNER,
            resolver: FORWARD_RESOLVER,
            addressOf: TARGET,
        });
        const r = await resolveDotNs("bob.alice.dot", { runtime });
        expect(r).toEqual({
            ok: true,
            value: { address: TARGET, name: "bob.alice.dot", owner: OWNER },
        });
    });

    test("a subname hashes to a different node than its parent", async () => {
        const sub = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("bob.alice.dot", { runtime: sub });
        const parent = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("alice.dot", { runtime: parent });
        expect(sub.calls[0]?.args?.[0]).not.toBe(parent.calls[0]?.args?.[0]);
    });

    test("a record can be set on a subname", async () => {
        const runtime = runtimeWith({ resolver: FORWARD_RESOLVER });
        const r = await setDotNsRecord(
            { name: "bob.alice.dot", address: TARGET },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(true);
    });

    test("registration still refuses a subname, since the registrar only mints single labels", async () => {
        const runtime = runtimeWith({});
        const r = await prepareDotNsRegistration(
            { name: "bob.alice.dot", owner: OWNER },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidName");
    });

    test("availability still refuses a subname", async () => {
        const runtime = runtimeWith({ available: true });
        const r = await isDotNsAvailable("bob.alice.dot", { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidName");
    });

    test("a malformed label anywhere in the path is rejected as InvalidName", async () => {
        // Asserting the reason, not just !ok: an empty fake runtime makes the
        // call fail anyway, so `ok === false` alone would pass for any input.
        const runtime = runtimeWith({});
        for (const bad of ["a.alice.dot", "bob..alice.dot", "-bob.alice.dot", "bob.al ice.dot"]) {
            const r = await resolveDotNs(bad, { runtime });
            expect(r.ok, bad).toBe(false);
            if (!r.ok) expect(r.error.reason, bad).toBe("InvalidName");
        }
        expect(runtime.calls, "rejected before any contract call").toHaveLength(0);
    });

    test("an uppercase subname is normalized rather than rejected", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        const r = await resolveDotNs("BOB.Alice.DOT", { runtime });
        expect(r).toEqual({ ok: true, value: { name: "bob.alice.dot", owner: OWNER } });
    });
});
