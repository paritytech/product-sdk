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
import type { SS58String } from "polkadot-api";
import { describe, expect, test } from "vitest";
import {
    DOTNS_POP_RULES_ABI,
    DOTNS_PROTOCOL_REGISTRY_ABI,
    DOTNS_REGISTRAR_CONTROLLER_ABI,
    DOTNS_REGISTRY_ABI,
    DOTNS_RESOLVER_ABI,
    DOTNS_RESOLVER_WRITE_ABI,
    DOTNS_REVERSE_RESOLVER_ABI,
    DOTNS_ADDRESSES,
    POP_STATUS,
} from "./dotns-abis.js";
import { DotNsError } from "./dotns-errors.js";
import {
    isDotNsAvailable,
    prepareDotNsRegistration,
    resolveDotNs,
    resolveTld,
    reverseDotNs,
    setDotNsRecord,
} from "./dotns-registry.js";
import { DOT_TLD, dotNsTld, namehash } from "./dotns-namehash.js";

/** A second protocol-registry address, to prove the TLD cache keys on it. */
const OTHER_REGISTRY = "0x9999999999999999999999999999999999999999" as const;

// These suites pass `tld: DOT_TLD` explicitly so they exercise resolution,
// writes and pricing rather than the TLD read — that path has its own suite in
// `describe("resolveTld")`, and the entry-point/`.paseo` wiring has
// `describe("the deployment's TLD reaches every entry point")`. Supplying the
// TLD also keeps validation free of IO, which is what lets the cases below
// assert an `InvalidName` against a runtime that would throw if touched.
// Never reached on the validation path (the calls reject before touching it).
const opts = { runtime: {} as ContractRuntime, tld: DOT_TLD };

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
const FORWARD_RESOLVER = DOTNS_ADDRESSES.resolver;
const REVERSE_RESOLVER = DOTNS_ADDRESSES.reverseResolver;
/** classifyName returns two values, so the fake encodes it positionally. */
const OPEN = [POP_STATUS.NoStatus, "Available to all"];

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
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({
            ok: true,
            value: { address: TARGET, name: "alice.dot", owner: OWNER },
        });
    });

    test("a node pointed at the reverse resolver is registered with no forward record", async () => {
        // The state of every name straight after registration.
        const runtime = runtimeWith({ owner: OWNER, resolver: REVERSE_RESOLVER });
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: { name: "alice.dot", owner: OWNER } });
        // addressOf must not be attempted against the reverse resolver.
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("addressOf");
    });

    test("the reverse-resolver comparison ignores address casing", async () => {
        const runtime = runtimeWith({
            owner: OWNER,
            resolver: REVERSE_RESOLVER.toLowerCase(),
        });
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        expect(r.ok && r.value?.address).toBeUndefined();
    });

    test("an unset resolver pointer is also registered with no forward record", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: { name: "alice.dot", owner: OWNER } });
    });

    test("a forward resolver holding an empty record has no address", async () => {
        const runtime = runtimeWith({
            owner: OWNER,
            resolver: FORWARD_RESOLVER,
            addressOf: ZERO,
        });
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: { name: "alice.dot", owner: OWNER } });
    });

    test("a zero owner means unregistered, reported as null not as a record", async () => {
        const runtime = runtimeWith({ owner: ZERO, resolver: ZERO });
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: null });
    });

    test("an unregistered name and a registered one are distinguishable", async () => {
        const unregistered = await resolveDotNs("alice.dot", {
            runtime: runtimeWith({ owner: ZERO, resolver: ZERO }),
            tld: DOT_TLD,
        });
        const registered = await resolveDotNs("alice.dot", {
            runtime: runtimeWith({ owner: OWNER, resolver: REVERSE_RESOLVER }),
            tld: DOT_TLD,
        });
        expect(unregistered.ok && unregistered.value).toBeNull();
        expect(registered.ok && registered.value).not.toBeNull();
    });

    test("honours the address overrides instead of the defaults", async () => {
        // Proves the branch above keys off `opts`, not off the hardcoded table.
        // Note the reverse-resolver override no longer decides anything here: any
        // pointer that is not the forward resolver means "no forward record". The
        // case is kept because it is the shape a registered name really has.
        const customRegistry = "0x3333333333333333333333333333333333333333";
        const customReverse = "0x4444444444444444444444444444444444444444";
        const runtime = runtimeWith({ owner: OWNER, resolver: customReverse });
        const r = await resolveDotNs("alice.dot", {
            runtime,
            registryAddress: customRegistry,
            reverseResolverAddress: customReverse,
            tld: DOT_TLD,
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
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });
});

describe("isDotNsAvailable", () => {
    test("asks the registrar controller rather than inferring from resolution", async () => {
        const runtime = runtimeWith({ available: true, classifyName: OPEN });
        const r = await isDotNsAvailable("alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: true });
        expect(runtime.calls.map((c) => c.functionName).sort()).toEqual([
            "available",
            "classifyName",
        ]);
    });

    test("passes the bare label, without the .dot suffix", async () => {
        const runtime = runtimeWith({ available: true, classifyName: OPEN });
        await isDotNsAvailable("alice.dot", { runtime, tld: DOT_TLD });
        expect(runtime.calls[0]?.args).toEqual(["alice"]);
    });

    test("an owned name with no forward record is not available", async () => {
        // This shape used to report `true`, costing the caller a commit fee.
        const runtime = runtimeWith({
            available: false,
            classifyName: OPEN,
            owner: OWNER,
            resolver: ZERO,
        });
        const r = await isDotNsAvailable("alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: false });
    });

    test("an invalid name is rejected before the controller call", async () => {
        const runtime = runtimeWith({ available: true, classifyName: OPEN });
        const r = await isDotNsAvailable("no", { runtime, tld: DOT_TLD });
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
            { runtime, origin: SIGNER, tld: DOT_TLD },
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
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toHaveLength(1);
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("setResolver");
    });

    test("the pointer move targets the forward resolver for the right node", async () => {
        const runtime = runtimeWith({ resolver: ZERO });
        await setDotNsRecord(
            { name: "alice.dot", address: TARGET },
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
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
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });
});

describe("origin", () => {
    test("reads pass the pallet-revive fallback rather than leaving it unset", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
        // Explicit, so the contracts layer does not warn once per query.
        expect(runtime.calls.every((c) => c.origin === QUERY_FALLBACK_ORIGIN)).toBe(true);
    });

    test("reads use opts.origin when given", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("alice.dot", { runtime, origin: SIGNER, tld: DOT_TLD });
        expect(runtime.calls.every((c) => c.origin === SIGNER)).toBe(true);
    });

    test("setDotNsRecord dry-runs as the caller, not the fallback account", async () => {
        const runtime = runtimeWith({ resolver: REVERSE_RESOLVER });
        await setDotNsRecord(
            { name: "alice.dot", address: TARGET },
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        const writes = runtime.calls.filter((c) =>
            ["setResolver", "setAddress"].includes(c.functionName ?? ""),
        );
        expect(writes).toHaveLength(2);
        expect(writes.every((c) => c.origin === SIGNER)).toBe(true);
        expect(writes.every((c) => c.origin !== QUERY_FALLBACK_ORIGIN)).toBe(true);
    });

    test("setDotNsRecord without an origin fails before any call", async () => {
        const runtime = runtimeWith({ resolver: REVERSE_RESOLVER });
        const r = await setDotNsRecord(
            { name: "alice.dot", address: TARGET },
            { runtime, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("MissingOrigin");
        expect(runtime.calls).toHaveLength(0);
    });

    test("prepareDotNsRegistration without an origin fails before any call", async () => {
        const runtime = runtimeWith({});
        const r = await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("MissingOrigin");
        expect(runtime.calls).toHaveLength(0);
    });

    test("prepareDotNsRegistration with a malformed origin fails before any call", async () => {
        // ss58ToH160 throws on an undecodable address. Every function here
        // promises a Result, so the throw has to be converted, not escape.
        const runtime = runtimeWith({});
        const r = await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, origin: "not-an-ss58-address" as SS58String, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidOrigin");
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
            { runtime, origin: SIGNER, tld: DOT_TLD },
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
            available: true,
            ...over,
        });

    const REG = { name: "alice.dot", owner: OWNER };
    const withSigner = (runtime: ReturnType<typeof runtimeWith>) => ({
        runtime,
        origin: SIGNER,
        tld: DOT_TLD,
    });

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
                if (functionName === "available") return true;
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
        const r = await resolveDotNs("alice.dot", { runtime, tld: DOT_TLD });
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
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.cause).toBeDefined();
            expect(JSON.stringify(r.error.cause)).toContain("Unauthorised");
        }
    });

    test("a failed availability read carries its payload", async () => {
        const runtime = runtimeWith({
            available: fakeDryRunResult({ failure: FAILURE }),
            classifyName: OPEN,
        });
        const r = await isDotNsAvailable("alice.dot", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.cause).toEqual(FAILURE);
    });

    test("a failed pricing read carries its payload", async () => {
        const runtime = runtimeWith({
            makeCommitment: `0x${"ab".repeat(32)}`,
            priceWithoutCheck: fakeDryRunResult({ failure: FAILURE }),
            minCommitmentAge: 60n,
            maxCommitmentAge: 86400n,
            available: true,
        });
        const r = await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, origin: SIGNER, tld: DOT_TLD },
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
        const r = await resolveDotNs("bob.alice.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({
            ok: true,
            value: { address: TARGET, name: "bob.alice.dot", owner: OWNER },
        });
    });

    test("a subname hashes to a different node than its parent", async () => {
        const sub = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("bob.alice.dot", { runtime: sub, tld: DOT_TLD });
        const parent = runtimeWith({ owner: OWNER, resolver: ZERO });
        await resolveDotNs("alice.dot", { runtime: parent, tld: DOT_TLD });
        expect(sub.calls[0]?.args?.[0]).not.toBe(parent.calls[0]?.args?.[0]);
    });

    test("a record can be set on a subname", async () => {
        const runtime = runtimeWith({ resolver: FORWARD_RESOLVER });
        const r = await setDotNsRecord(
            { name: "bob.alice.dot", address: TARGET },
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(r.ok).toBe(true);
    });

    test("registration still refuses a subname, since the registrar only mints single labels", async () => {
        const runtime = runtimeWith({});
        const r = await prepareDotNsRegistration(
            { name: "bob.alice.dot", owner: OWNER },
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidName");
    });

    test("availability still refuses a subname", async () => {
        const runtime = runtimeWith({ available: true, classifyName: OPEN });
        const r = await isDotNsAvailable("bob.alice.dot", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidName");
    });

    test("a malformed label anywhere in the path is rejected as InvalidName", async () => {
        // Asserting the reason, not just !ok: an empty fake runtime makes the
        // call fail anyway, so `ok === false` alone would pass for any input.
        const runtime = runtimeWith({});
        for (const bad of ["a.alice.dot", "bob..alice.dot", "-bob.alice.dot", "bob.al ice.dot"]) {
            const r = await resolveDotNs(bad, { runtime, tld: DOT_TLD });
            expect(r.ok, bad).toBe(false);
            if (!r.ok) expect(r.error.reason, bad).toBe("InvalidName");
        }
        expect(runtime.calls, "rejected before any contract call").toHaveLength(0);
    });

    test("an uppercase subname is normalized rather than rejected", async () => {
        const runtime = runtimeWith({ owner: OWNER, resolver: ZERO });
        const r = await resolveDotNs("BOB.Alice.DOT", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: { name: "bob.alice.dot", owner: OWNER } });
    });
});

describe("availability and registration agree", () => {
    const OPEN_LABEL = [POP_STATUS.NoStatus, "Available to all"];
    const GOV = [POP_STATUS.Reserved, "Reserved for Governance"];

    test("a governance-reserved label is not available, even though it is unminted", async () => {
        // available() only asks the registrar whether the token is minted, and
        // says yes for a 3 to 5 character label that can never be claimed.
        const runtime = runtimeWith({ available: true, classifyName: GOV });
        const r = await isDotNsAvailable("bob.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: false });
    });

    test("availability and registration now give the same verdict on a reserved label", async () => {
        const avail = await isDotNsAvailable("bob.dot", {
            runtime: runtimeWith({ available: true, classifyName: GOV }),
            tld: DOT_TLD,
        });
        const reg = await prepareDotNsRegistration(
            { name: "bob.dot", owner: OWNER },
            {
                runtime: runtimeWith({
                    available: true,
                    makeCommitment: `0x${"ab".repeat(32)}`,
                    priceWithoutCheck: {
                        price: 0n,
                        status: POP_STATUS.Reserved,
                        userStatus: POP_STATUS.NoStatus,
                        message: "Reserved for Governance",
                    },
                    minCommitmentAge: 60n,
                    maxCommitmentAge: 86400n,
                }),
                origin: SIGNER,
                tld: DOT_TLD,
            },
        );
        expect(avail.ok && avail.value).toBe(false);
        expect(reg.ok).toBe(false);
        if (!reg.ok) expect(reg.error.reason).toBe("NameReserved");
    });

    test("a failing classifyName is an error, not a false", async () => {
        const runtime = runtimeWith({
            available: true,
            classifyName: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await isDotNsAvailable("alice.dot", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });

    test("an unminted, unrestricted label is available", async () => {
        const runtime = runtimeWith({ available: true, classifyName: OPEN_LABEL });
        expect(await isDotNsAvailable("longenough.dot", { runtime, tld: DOT_TLD })).toEqual({
            ok: true,
            value: true,
        });
    });
});

describe("registration refuses a taken name before the commit", () => {
    const base = {
        makeCommitment: `0x${"ab".repeat(32)}`,
        priceWithoutCheck: {
            price: 1000n,
            status: POP_STATUS.NoStatus,
            userStatus: POP_STATUS.NoStatus,
            message: "Available to all",
        },
        transferFloor: 0n,
        minCommitmentAge: 60n,
        maxCommitmentAge: 86400n,
    };

    test("a taken name fails as NameUnavailable with no commit prepared", async () => {
        // register runs _requireAvailableLabel first, so without this the caller
        // pays for the commit and only then reverts with NameNotAvailable.
        const runtime = runtimeWith({ ...base, available: false });
        const r = await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("NameUnavailable");
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("commit");
    });

    test("availability is actually consulted", async () => {
        const runtime = runtimeWith({ ...base, available: true });
        await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(runtime.calls.map((c) => c.functionName)).toContain("available");
    });

    test("a failing availability read is an error, not an assumed yes", async () => {
        const runtime = runtimeWith({
            ...base,
            available: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await prepareDotNsRegistration(
            { name: "alice.dot", owner: OWNER },
            { runtime, origin: SIGNER, tld: DOT_TLD },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });
});

describe("resolveTld", () => {
    /** A runtime whose protocol registry answers `tld()` / `tldNode()` as told. */
    function registryRuntime(answers: { tld?: unknown; tldNode?: unknown }) {
        return createFakeContractRuntime({
            abi: [...ALL_ABIS, ...DOTNS_PROTOCOL_REGISTRY_ABI],
            onQuery: ({ functionName }) => {
                if (functionName === "tld") return answers.tld;
                if (functionName === "tldNode") return answers.tldNode;
                return undefined;
            },
        });
    }

    const PASEO = dotNsTld(".paseo");
    /** Both getters absent, which is what a pre-b4096968 deployment looks like. */
    const NO_GETTER = fakeDryRunResult({ revert: true });

    test("reads the suffix from the chain and derives the node", async () => {
        const runtime = registryRuntime({ tld: ".paseo", tldNode: PASEO.node });
        const r = await resolveTld({ runtime });
        expect(r).toEqual({ ok: true, value: PASEO });
    });

    test("derives the node itself, so tldNode() is not required to answer", async () => {
        const runtime = registryRuntime({ tld: ".paseo", tldNode: NO_GETTER });
        const r = await resolveTld({ runtime });
        expect(r).toEqual({ ok: true, value: PASEO });
    });

    test("caches per runtime: a second call does not re-read", async () => {
        const runtime = registryRuntime({ tld: ".paseo", tldNode: PASEO.node });
        await resolveTld({ runtime });
        const afterFirst = runtime.calls.filter((c) => c.functionName === "tld").length;
        await resolveTld({ runtime });
        expect(runtime.calls.filter((c) => c.functionName === "tld").length).toBe(afterFirst);
        expect(afterFirst).toBe(1);
    });

    test("concurrent first calls share one read", async () => {
        const runtime = registryRuntime({ tld: ".paseo", tldNode: PASEO.node });
        const [a, b, c] = await Promise.all([
            resolveTld({ runtime }),
            resolveTld({ runtime }),
            resolveTld({ runtime }),
        ]);
        expect(runtime.calls.filter((x) => x.functionName === "tld").length).toBe(1);
        expect([a, b, c]).toEqual([
            { ok: true, value: PASEO },
            { ok: true, value: PASEO },
            { ok: true, value: PASEO },
        ]);
    });

    test("the cache is per runtime, not global", async () => {
        const one = registryRuntime({ tld: ".paseo", tldNode: PASEO.node });
        const two = registryRuntime({ tld: ".dot", tldNode: DOT_TLD.node });
        expect(await resolveTld({ runtime: one })).toEqual({ ok: true, value: PASEO });
        expect(await resolveTld({ runtime: two })).toEqual({ ok: true, value: DOT_TLD });
        expect(one.calls.filter((c) => c.functionName === "tld").length).toBe(1);
        expect(two.calls.filter((c) => c.functionName === "tld").length).toBe(1);
    });

    test("the cache key includes the protocol registry address", async () => {
        // One runtime pointed at two registries has two TLDs; keying on the
        // runtime alone would serve the first answer for both.
        const runtime = registryRuntime({ tld: ".paseo", tldNode: PASEO.node });
        await resolveTld({ runtime });
        await resolveTld({ runtime, protocolRegistryAddress: OTHER_REGISTRY });
        expect(runtime.calls.filter((c) => c.functionName === "tld").length).toBe(2);
    });

    test("a supplied tld skips the chain entirely", async () => {
        const runtime = registryRuntime({ tld: ".paseo", tldNode: PASEO.node });
        const r = await resolveTld({ runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: DOT_TLD });
        expect(runtime.calls).toHaveLength(0);
    });

    test("a supplied tld whose node does not match its suffix is refused", async () => {
        // The override path re-creating the original bug: `.paseo` names rooted
        // at the `.dot` node.
        const runtime = registryRuntime({ tld: ".paseo", tldNode: PASEO.node });
        const r = await resolveTld({
            runtime,
            tld: { suffix: ".paseo", node: DOT_TLD.node },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidTld");
    });

    test("an absent getter falls back to .dot, because that TLD was compiled in", async () => {
        // Pre-b4096968 deployments had no tld() and no way to be anything but
        // `.dot`. Verified against Paseo Asset Hub Previewnet.
        const runtime = registryRuntime({ tld: NO_GETTER, tldNode: NO_GETTER });
        expect(await resolveTld({ runtime })).toEqual({ ok: true, value: DOT_TLD });
    });

    test("a dispatch failure is an error, not a fallback", async () => {
        const runtime = registryRuntime({
            tld: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await resolveTld({ runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });

    test("a revert carrying a reason is an error, not a fallback", async () => {
        // Only an *empty* revert means "no such function". A reverting getter
        // that has something to say is a real failure.
        const runtime = registryRuntime({ tld: fakeDryRunResult({ revert: "nope" }) });
        const r = await resolveTld({ runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });

    test("a failed read is not cached, so the next call retries", async () => {
        let firstCall = true;
        const runtime = createFakeContractRuntime({
            abi: [...ALL_ABIS, ...DOTNS_PROTOCOL_REGISTRY_ABI],
            onQuery: ({ functionName }) => {
                if (functionName === "tldNode") return PASEO.node;
                if (functionName !== "tld") return undefined;
                if (firstCall) {
                    firstCall = false;
                    return fakeDryRunResult({ failure: { type: "ContractTrapped" } });
                }
                return ".paseo";
            },
        });
        expect((await resolveTld({ runtime })).ok).toBe(false);
        expect(await resolveTld({ runtime })).toEqual({ ok: true, value: PASEO });
    });

    test("an empty suffix is refused, not treated as the ENS root", async () => {
        // What an upgraded-but-unmigrated proxy reports: the getters succeed and
        // return `_tld` = "" with `_tldNode` = 0, which would reroot every name.
        const runtime = registryRuntime({ tld: "", tldNode: `0x${"00".repeat(32)}` });
        const r = await resolveTld({ runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidTld");
    });

    test("a multi-label suffix is refused, since initialize cannot produce one", async () => {
        const runtime = registryRuntime({ tld: ".a.b" });
        const r = await resolveTld({ runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidTld");
    });

    test("a tldNode() that contradicts tld() is refused, trusting neither", async () => {
        const runtime = registryRuntime({ tld: ".paseo", tldNode: DOT_TLD.node });
        const r = await resolveTld({ runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("InvalidTld");
    });
});

describe("the deployment's TLD reaches every entry point", () => {
    const PASEO = dotNsTld(".paseo");

    /**
     * `dim2` under the `.paseo` root, as read from `DotnsRegistry` on
     * paseo-asset-hub-next — the node the chain actually keys that name by.
     *
     * Pinned from the chain rather than computed here: it is what makes these
     * assertions evidence about the deployment instead of a restatement of
     * `namehash`. Under the old hardcoded `.dot` root the same name hashed to
     * 0xec7bd203… , which is owned by nobody, which is why every lookup
     * reported "unregistered".
     */
    const DIM2_UNDER_PASEO = "0x4eeda1749326395729498c3df6e0cf87fe912297bbf35c4f2549c19d77f56dad";

    /** A deployment whose protocol registry reports `.paseo`. */
    function paseoRuntime(answers: Record<string, unknown> = {}) {
        return createFakeContractRuntime({
            abi: [...ALL_ABIS, ...DOTNS_PROTOCOL_REGISTRY_ABI],
            onQuery: ({ functionName }) => {
                if (functionName === "tld") return ".paseo";
                if (functionName === "tldNode") return PASEO.node;
                return answers[functionName ?? ""];
            },
        });
    }

    const nodesFor = (runtime: ReturnType<typeof paseoRuntime>, fn: string) =>
        runtime.calls.filter((c) => c.functionName === fn).map((c) => c.args?.[0]);

    test("resolveDotNs hashes under the chain's TLD, not a compiled-in one", async () => {
        const runtime = paseoRuntime({ owner: OWNER, resolver: ZERO });
        const r = await resolveDotNs("dim2.paseo", { runtime });
        expect(r).toEqual({ ok: true, value: { name: "dim2.paseo", owner: OWNER } });
        // The assertion that would have caught the original bug.
        expect(nodesFor(runtime, "owner")).toEqual([DIM2_UNDER_PASEO]);
        expect(namehash("dim2.paseo", PASEO)).toBe(DIM2_UNDER_PASEO);
    });

    test("a bare label picks up the deployment's suffix", async () => {
        const runtime = paseoRuntime({ owner: OWNER, resolver: ZERO });
        const r = await resolveDotNs("dim2", { runtime });
        expect(r).toEqual({ ok: true, value: { name: "dim2.paseo", owner: OWNER } });
        expect(nodesFor(runtime, "owner")).toEqual([DIM2_UNDER_PASEO]);
    });

    test("a name from another deployment is refused, not resolved under ours", async () => {
        const runtime = paseoRuntime({ owner: OWNER, resolver: ZERO });
        const r = await resolveDotNs("dim2.dot", { runtime });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.reason).toBe("TldMismatch");
            // The message has to name the deployment's TLD, or the caller cannot
            // tell this apart from a typo.
            expect(r.error.message).toContain(".paseo");
        }
        // Nothing beyond the TLD read: no registry lookup for a foreign name.
        expect(runtime.calls.map((c) => c.functionName)).toEqual(["tld", "tldNode"]);
    });

    test("setDotNsRecord targets the same node resolveDotNs reads", async () => {
        const runtime = paseoRuntime({ resolver: DOTNS_ADDRESSES.resolver });
        const r = await setDotNsRecord(
            { name: "dim2.paseo", address: TARGET },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(true);
        expect(nodesFor(runtime, "resolver")).toEqual([DIM2_UNDER_PASEO]);
        expect(nodesFor(runtime, "setAddress")).toEqual([DIM2_UNDER_PASEO]);
    });

    test("isDotNsAvailable sends the whole label, not one truncated by four", async () => {
        const runtime = paseoRuntime({
            available: true,
            // Multi-output returns are encoded positionally, as the suites above do.
            classifyName: [POP_STATUS.PopLite, ""],
        });
        const r = await isDotNsAvailable("dim2.paseo", { runtime });
        expect(r).toEqual({ ok: true, value: true });
        // `slice(0, -4)` would send "dim2.pa" here.
        expect(nodesFor(runtime, "available")).toEqual(["dim2"]);
        expect(nodesFor(runtime, "classifyName")).toEqual(["dim2"]);
    });

    test("prepareDotNsRegistration sends the whole label too", async () => {
        const runtime = paseoRuntime({
            available: true,
            makeCommitment: `0x${"ab".repeat(32)}`,
            priceWithoutCheck: [1n, POP_STATUS.NoStatus, POP_STATUS.PopFull, ""],
            transferFloor: 0n,
            minCommitmentAge: 60n,
            maxCommitmentAge: 86400n,
        });
        const r = await prepareDotNsRegistration(
            { name: "dim2.paseo", owner: OWNER },
            { runtime, origin: SIGNER },
        );
        expect(r.ok).toBe(true);
        expect(nodesFor(runtime, "available")).toEqual(["dim2"]);
    });

    test("reverseDotNs needs no TLD, and reads none", async () => {
        const runtime = paseoRuntime({ nameOf: "dim2.paseo" });
        const r = await reverseDotNs(OWNER, { runtime });
        expect(r).toEqual({ ok: true, value: "dim2.paseo" });
        expect(runtime.calls.map((c) => c.functionName)).toEqual(["nameOf"]);
    });

    test("every entry point consults the chain when no tld is supplied", async () => {
        // The regression guard for the whole change: if any entry point stops
        // asking, it is back to assuming a root.
        for (const call of [
            (runtime: ReturnType<typeof paseoRuntime>) => resolveDotNs("dim2.paseo", { runtime }),
            (runtime: ReturnType<typeof paseoRuntime>) =>
                isDotNsAvailable("dim2.paseo", { runtime }),
            (runtime: ReturnType<typeof paseoRuntime>) =>
                setDotNsRecord(
                    { name: "dim2.paseo", address: TARGET },
                    { runtime, origin: SIGNER },
                ),
            (runtime: ReturnType<typeof paseoRuntime>) =>
                prepareDotNsRegistration(
                    { name: "dim2.paseo", owner: OWNER },
                    { runtime, origin: SIGNER },
                ),
        ]) {
            const runtime = paseoRuntime({ owner: OWNER, resolver: ZERO, available: true });
            await call(runtime);
            expect(runtime.calls.map((c) => c.functionName)).toContain("tld");
        }
    });

    test("a legacy deployment with no tld() getter still resolves .dot names", async () => {
        // Paseo Asset Hub Previewnet: both getters revert empty, and `dim2` is
        // owned there under the `.dot` root. The fix must not break it.
        const runtime = createFakeContractRuntime({
            abi: [...ALL_ABIS, ...DOTNS_PROTOCOL_REGISTRY_ABI],
            onQuery: ({ functionName }) => {
                if (functionName === "tld" || functionName === "tldNode") {
                    return fakeDryRunResult({ revert: true });
                }
                if (functionName === "owner") return OWNER;
                if (functionName === "resolver") return ZERO;
                return undefined;
            },
        });
        const r = await resolveDotNs("dim2.dot", { runtime });
        expect(r).toEqual({ ok: true, value: { name: "dim2.dot", owner: OWNER } });
        expect(nodesFor(runtime, "owner")).toEqual([namehash("dim2.dot", DOT_TLD)]);
    });
});

describe("the resolver pointer is an allowlist, not a denylist", () => {
    /**
     * `DotnsContentResolver` on Paseo Asset Hub Next V2, from walking
     * `protocolRegistry.get(bytes32("contentResolver"))`.
     *
     * The live pointer for `dim2` on both networks. It is a real contract with no
     * `addressOf`, so asking it for an address reverts — which is why a
     * registered, owned name used to come back as `err RegistryCall`.
     */
    const CONTENT_RESOLVER = "0x7F74D7CD50f5a834270E2ad395a01b01891AB37d";
    /** `DotnsPopResolver` from the same walk: a fourth resolver, equally unknown here. */
    const POP_RESOLVER = "0xDaC984884EcA8Fc44011f1D6C49B27828390A72B";

    /** A runtime where the node is owned and points at `resolverAddr`. */
    const ownedPointingAt = (resolverAddr: string) =>
        createFakeContractRuntime({
            abi: ALL_ABIS,
            onQuery: ({ functionName }) => {
                if (functionName === "owner") return OWNER;
                if (functionName === "resolver") return resolverAddr;
                // Asking any of these for an address reverts, as the real ones do.
                if (functionName === "addressOf") return fakeDryRunResult({ revert: true });
                return undefined;
            },
        });

    test("a resolver we do not know means no forward record, not an error", async () => {
        // The assertion no earlier test could make: every fake until now returned
        // one of the three pointers the code contemplated, so a fourth resolver
        // was unreachable by construction.
        const runtime = ownedPointingAt(CONTENT_RESOLVER);
        const r = await resolveDotNs("dim2.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: { name: "dim2.dot", owner: OWNER } });
        expect(runtime.calls.map((c) => c.functionName)).not.toContain("addressOf");
    });

    test("the same holds for the PoP resolver, and for one nobody has deployed yet", async () => {
        for (const pointer of [POP_RESOLVER, "0x1234512345123451234512345123451234512345"]) {
            const runtime = ownedPointingAt(pointer);
            const r = await resolveDotNs("dim2.dot", { runtime, tld: DOT_TLD });
            expect(r).toEqual({ ok: true, value: { name: "dim2.dot", owner: OWNER } });
            expect(runtime.calls.map((c) => c.functionName)).not.toContain("addressOf");
        }
    });

    test("the forward resolver is still asked, and still answers", async () => {
        const runtime = createFakeContractRuntime({
            abi: ALL_ABIS,
            onQuery: ({ functionName }) => {
                if (functionName === "owner") return OWNER;
                if (functionName === "resolver") return DOTNS_ADDRESSES.resolver;
                if (functionName === "addressOf") return TARGET;
                return undefined;
            },
        });
        const r = await resolveDotNs("dim2.dot", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: { address: TARGET, name: "dim2.dot", owner: OWNER } });
        expect(runtime.calls.map((c) => c.functionName)).toContain("addressOf");
    });

    test("an overridden forward resolver is the one that gets asked", async () => {
        // The allowlist has to key off `opts`, not the hardcoded table, or an
        // override silently turns every name into "no forward record".
        const custom = "0x5555555555555555555555555555555555555555";
        const runtime = createFakeContractRuntime({
            abi: ALL_ABIS,
            onQuery: ({ functionName }) => {
                if (functionName === "owner") return OWNER;
                if (functionName === "resolver") return custom;
                if (functionName === "addressOf") return TARGET;
                return undefined;
            },
        });
        const r = await resolveDotNs("dim2.dot", {
            runtime,
            tld: DOT_TLD,
            resolverAddress: custom,
        });
        expect(r).toEqual({ ok: true, value: { address: TARGET, name: "dim2.dot", owner: OWNER } });
    });
});
