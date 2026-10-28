// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The dotNS walk through `createFakeContractRuntime`: the real ABI codec, no
// chain. The TLD is supplied so the walk starts at the registry.
import { createFakeContractRuntime, fakeDryRunResult } from "@parity/product-sdk-contracts/testing";
import { describe, expect, test } from "vitest";

import {
    DOTNS_ADDRESSES,
    DOTNS_CONTENT_RESOLVER_ABI,
    DOTNS_REGISTRY_ABI,
} from "../identity/dotns-abis.js";
import { DotNsError } from "../identity/dotns-errors.js";
import { DOT_TLD, namehash } from "../identity/dotns-namehash.js";
import { getProfile, isAcceptableProfileLabel, normalizeProfileLabel } from "./lookup.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const CONTENT_RESOLVER = "0x3333333333333333333333333333333333333333";

// devdevdev.01.paseo's current record: avatar (cid, webp) + name "devdev".
const RECORD =
    "CBhhdmF0YXIBAfhiYWZrMmJ6YWNlYnRtdW41Znk2NjNkdmZ3eWMzMzZjeHdkbGhtc2VraTNtanNlazZ3bXN5Z3R2ZjJuYjRlZwIQbmFtZRhkZXZkZXY=";

/** A runtime whose view calls answer from `answers`, keyed by function name. */
function runtimeWith(answers: Record<string, unknown>) {
    return createFakeContractRuntime({
        abi: [...DOTNS_REGISTRY_ABI, ...DOTNS_CONTENT_RESOLVER_ABI],
        onQuery: ({ functionName }) =>
            functionName && functionName in answers ? answers[functionName] : undefined,
    });
}

/** `name@dest` per call, the address lower-cased: the fake reports it as calldata carries it. */
const calls = (runtime: ReturnType<typeof runtimeWith>) =>
    runtime.calls.map((c) => `${c.functionName}@${c.dest.toLowerCase()}`);
const at = (address: string) => address.toLowerCase();

describe("label rules", () => {
    test("accept what the core accepts", () => {
        expect(isAcceptableProfileLabel("alice")).toBe(true);
        expect(isAcceptableProfileLabel("alice.42")).toBe(true);
        expect(isAcceptableProfileLabel("devdevdev.01")).toBe(true);
        expect(isAcceptableProfileLabel("a-b")).toBe(true);
        expect(isAcceptableProfileLabel("x".repeat(64))).toBe(true);
    });

    test("refuse what the core refuses", () => {
        expect(isAcceptableProfileLabel("")).toBe(false);
        expect(isAcceptableProfileLabel("x".repeat(65))).toBe(false);
        expect(isAcceptableProfileLabel("Alice")).toBe(false);
        expect(isAcceptableProfileLabel("alice.")).toBe(false);
        expect(isAcceptableProfileLabel(".alice")).toBe(false);
        expect(isAcceptableProfileLabel("al ice")).toBe(false);
        expect(isAcceptableProfileLabel("élan")).toBe(false);
    });

    test("normalisation trims, lower-cases and strips the deployment's TLD only", () => {
        expect(normalizeProfileLabel("  Alice.DOT ", DOT_TLD)).toBe("alice");
        expect(normalizeProfileLabel("alice.42.dot", DOT_TLD)).toBe("alice.42");
        expect(normalizeProfileLabel("alice.paseo", DOT_TLD)).toBe("alice.paseo");
    });
});

describe("getProfile", () => {
    const found = () => runtimeWith({ resolver: CONTENT_RESOLVER, text: RECORD });

    test("finds and decodes a record", async () => {
        const runtime = found();
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value?.name).toBe("devdev");
            expect(r.value?.avatar?.format).toBe("webp");
        }
        expect(calls(runtime)).toEqual([
            `resolver@${at(DOTNS_ADDRESSES.registry)}`,
            `text@${at(CONTENT_RESOLVER)}`,
        ]);
    });

    test("asks for the node of the full name, with a lite name's parts as levels", async () => {
        const runtime = found();
        await getProfile("alice.42", { runtime, tld: DOT_TLD });
        expect(runtime.calls[0]?.args?.[0]).toBe(namehash("alice.42.dot", DOT_TLD));
        expect(runtime.calls[1]?.args).toEqual([namehash("alice.42.dot", DOT_TLD), "profile"]);
    });

    test("a trailing TLD is tolerated and hashes to the same node", async () => {
        const bare = found();
        const suffixed = found();
        await getProfile("alice", { runtime: bare, tld: DOT_TLD });
        await getProfile("Alice.dot", { runtime: suffixed, tld: DOT_TLD });
        expect(suffixed.calls[0]?.args).toEqual(bare.calls[0]?.args);
    });

    test("an unacceptable label is a failure before any call", async () => {
        const runtime = found();
        for (const label of ["", "Al ice", "x".repeat(65)]) {
            const r = await getProfile(label, { runtime, tld: DOT_TLD });
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.error).toBeInstanceOf(DotNsError);
                expect(r.error.reason).toBe("InvalidName");
            }
        }
        expect(runtime.calls).toHaveLength(0);
    });

    test("no resolver is no profile, and text is never asked for", async () => {
        const runtime = runtimeWith({ resolver: ZERO, text: RECORD });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: null });
        expect(calls(runtime)).toEqual([`resolver@${at(DOTNS_ADDRESSES.registry)}`]);
    });

    test("a resolver whose text reverts is no profile, not a failure", async () => {
        // A name registered and never moved off the reverse resolver.
        const runtime = runtimeWith({
            resolver: DOTNS_ADDRESSES.reverseResolver,
            text: fakeDryRunResult({ revert: true }),
        });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r).toEqual({ ok: true, value: null });
        expect(calls(runtime)).toEqual([
            `resolver@${at(DOTNS_ADDRESSES.registry)}`,
            `text@${at(DOTNS_ADDRESSES.reverseResolver)}`,
        ]);
    });

    test("an empty record is no profile", async () => {
        const runtime = runtimeWith({ resolver: CONTENT_RESOLVER, text: "" });
        expect(await getProfile("alice", { runtime, tld: DOT_TLD })).toEqual({
            ok: true,
            value: null,
        });
    });

    test("a record that does not decode is no profile", async () => {
        for (const text of ["not base64!", "AAAA", "QQ=="]) {
            const runtime = runtimeWith({ resolver: CONTENT_RESOLVER, text });
            expect(await getProfile("alice", { runtime, tld: DOT_TLD })).toEqual({
                ok: true,
                value: null,
            });
        }
    });

    test("a text call that fails without a revert is a failure", async () => {
        const runtime = runtimeWith({
            resolver: CONTENT_RESOLVER,
            text: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });

    test("a resolver call that fails is a failure", async () => {
        const runtime = runtimeWith({
            resolver: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });

    test("a runtime that throws is a failure carrying the cause", async () => {
        const boom = new Error("socket closed");
        const runtime = createFakeContractRuntime({
            abi: DOTNS_REGISTRY_ABI,
            onQuery: () => {
                throw boom;
            },
        });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error.reason).toBe("RegistryCall");
            expect(r.error.cause).toBe(boom);
        }
    });
});
