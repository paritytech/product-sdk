// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The dotNS walk through `createFakeContractRuntime`: the real ABI codec, no
// chain. The TLD is supplied so the walk starts at the protocol registry's
// content resolver.
import { createFakeContractRuntime, fakeDryRunResult } from "@parity/product-sdk-contracts/testing";
import { describe, expect, test } from "vitest";

import {
    DOTNS_ADDRESSES,
    DOTNS_CONTENT_RESOLVER_ABI,
    DOTNS_PROTOCOL_REGISTRY_ABI,
} from "../identity/dotns-abis.js";
import { DOTNS_CONTENT_RESOLVER_KEY, ZERO_ADDRESS as ZERO } from "../identity/dotns-addresses.js";
import { DotNsError } from "../identity/dotns-errors.js";
import { DOT_TLD, namehash } from "../identity/dotns-namehash.js";
import {
    getProfile,
    getProfileRecord,
    isAcceptableProfileLabel,
    normalizeProfileLabel,
    verifyPublishedProfile,
} from "./lookup.js";

const CONTENT_RESOLVER = "0x3333333333333333333333333333333333333333";

// The record `record.test.ts` pins: avatar (cid, webp) + name "Alice".
const RECORD = "CIgAC9G7V+P56oAZVqdw/hBo+VA4NUespF4dPTVNV9AUywwCHAEUQWxpY2U=";
// devdevdev.01.paseo's record in the layout that preceded the RFC: not a profile.
const PRE_RFC_RECORD =
    "CBhhdmF0YXIBAfhiYWZrMmJ6YWNlYnRtdW41Znk2NjNkdmZ3eWMzMzZjeHdkbGhtc2VraTNtanNlazZ3bXN5Z3R2ZjJuYjRlZwIQbmFtZRhkZXZkZXY=";
const NO_PROFILE = { ok: true, value: { tag: "NoProfile" } };

/**
 * A runtime whose view calls answer from `answers`, keyed by function name.
 * `get` is the protocol registry's component lookup; it answers the content
 * resolver for that key and zero for any other, as the real one does.
 */
function runtimeWith(answers: Record<string, unknown>) {
    return createFakeContractRuntime({
        abi: [...DOTNS_PROTOCOL_REGISTRY_ABI, ...DOTNS_CONTENT_RESOLVER_ABI],
        onQuery: ({ functionName, args }) => {
            if (functionName === "get") {
                return String(args?.[0]) === DOTNS_CONTENT_RESOLVER_KEY
                    ? (answers.contentResolver ?? CONTENT_RESOLVER)
                    : ZERO;
            }
            return functionName && functionName in answers ? answers[functionName] : undefined;
        },
    });
}

/** `name@dest` per call, the address lower-cased: the fake reports it as calldata carries it. */
const calls = (runtime: ReturnType<typeof runtimeWith>) =>
    runtime.calls.map((c) => `${c.functionName}@${c.dest.toLowerCase()}`);
const at = (address: string) => address.toLowerCase();
const GET = `get@${at(DOTNS_ADDRESSES.protocolRegistry)}`;
const TEXT = `text@${at(CONTENT_RESOLVER)}`;

describe("label rules", () => {
    test("accept what the core accepts: a DNS label, or a dotted lite username", () => {
        expect(isAcceptableProfileLabel("alice")).toBe(true);
        expect(isAcceptableProfileLabel("alice01")).toBe(true);
        expect(isAcceptableProfileLabel("alice-smith")).toBe(true);
        expect(isAcceptableProfileLabel("a".repeat(63))).toBe(true);
        expect(isAcceptableProfileLabel("alice.42")).toBe(true);
        expect(isAcceptableProfileLabel("devdevdev.01")).toBe(true);
        expect(isAcceptableProfileLabel(`${"a".repeat(29)}.01`)).toBe(true); // 32 bytes
    });

    test("refuse what the core refuses", () => {
        expect(isAcceptableProfileLabel("")).toBe(false);
        expect(isAcceptableProfileLabel("a".repeat(64))).toBe(false);
        expect(isAcceptableProfileLabel("Alice")).toBe(false);
        expect(isAcceptableProfileLabel("-alice")).toBe(false);
        expect(isAcceptableProfileLabel("alice-")).toBe(false);
        expect(isAcceptableProfileLabel("al ice")).toBe(false);
        expect(isAcceptableProfileLabel("élan")).toBe(false);
        // A lite name is a letter stem, one dot, exactly two digits, 32 bytes at most.
        expect(isAcceptableProfileLabel("alice.1")).toBe(false);
        expect(isAcceptableProfileLabel("alice.123")).toBe(false);
        expect(isAcceptableProfileLabel("alice1.01")).toBe(false);
        expect(isAcceptableProfileLabel("a.b.c")).toBe(false);
        expect(isAcceptableProfileLabel("alice.")).toBe(false);
        expect(isAcceptableProfileLabel(".alice")).toBe(false);
        expect(isAcceptableProfileLabel(`${"a".repeat(30)}.01`)).toBe(false); // 33 bytes
    });

    test("normalisation trims, lower-cases and strips the deployment's TLD only", () => {
        expect(normalizeProfileLabel("  Alice.DOT ", DOT_TLD)).toBe("alice");
        expect(normalizeProfileLabel("alice.42.dot", DOT_TLD)).toBe("alice.42");
        expect(normalizeProfileLabel("alice.paseo", DOT_TLD)).toBe("alice.paseo");
    });
});

describe("getProfile", () => {
    const found = () => runtimeWith({ text: RECORD });

    test("reads the record from the deployment's content resolver and decodes it", async () => {
        const runtime = found();
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.tag).toBe("Found");
            if (r.value.tag === "Found") {
                expect(r.value.profile.name).toBe("Alice");
                expect(r.value.profile.avatar?.format).toBe("webp");
            }
        }
        // The name's own resolver pointer is never consulted.
        expect(calls(runtime)).toEqual([GET, TEXT]);
    });

    test("the content resolver is read once per runtime", async () => {
        const runtime = found();
        await getProfile("alice", { runtime, tld: DOT_TLD });
        await getProfile("bob", { runtime, tld: DOT_TLD });
        expect(calls(runtime)).toEqual([GET, TEXT, TEXT]);
    });

    test("a supplied content resolver address skips the registry read", async () => {
        const runtime = found();
        const r = await getProfile("alice", {
            runtime,
            tld: DOT_TLD,
            contentResolverAddress: CONTENT_RESOLVER,
        });
        expect(r.ok && r.value.tag).toBe("Found");
        expect(calls(runtime)).toEqual([TEXT]);
    });

    test("asks for the node of the full name, with a lite name's parts as levels", async () => {
        const runtime = found();
        await getProfile("alice.42", { runtime, tld: DOT_TLD });
        expect(runtime.calls[1]?.args).toEqual([namehash("alice.42.dot", DOT_TLD), "profile"]);
    });

    test("a trailing TLD is tolerated and hashes to the same node", async () => {
        const bare = found();
        const suffixed = found();
        await getProfile("alice", { runtime: bare, tld: DOT_TLD });
        await getProfile("Alice.dot", { runtime: suffixed, tld: DOT_TLD });
        expect(suffixed.calls[1]?.args).toEqual(bare.calls[1]?.args);
    });

    test("an unacceptable label is a failure before any call", async () => {
        const runtime = found();
        for (const label of ["", "Al ice", "x".repeat(64), "alice.1"]) {
            const r = await getProfile(label, { runtime, tld: DOT_TLD });
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.error).toBeInstanceOf(DotNsError);
                expect(r.error.reason).toBe("InvalidName");
            }
        }
        expect(runtime.calls).toHaveLength(0);
    });

    test("a deployment without a content resolver has no profile, and text is never asked for", async () => {
        const runtime = runtimeWith({ contentResolver: ZERO, text: RECORD });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r).toEqual(NO_PROFILE);
        expect(calls(runtime)).toEqual([GET]);
    });

    test("an empty record is no profile", async () => {
        const runtime = runtimeWith({ text: "" });
        expect(await getProfile("alice", { runtime, tld: DOT_TLD })).toEqual(NO_PROFILE);
    });

    test("a record that does not decode is no profile, the pre-RFC layout included", async () => {
        for (const text of ["not base64!", "AAAA", "QQ==", PRE_RFC_RECORD]) {
            const runtime = runtimeWith({ text });
            expect(await getProfile("alice", { runtime, tld: DOT_TLD })).toEqual(NO_PROFILE);
        }
    });

    test("a text call that reverts is a failure, not an absent record", async () => {
        // The content resolver has `text`, so a revert is something wrong, as
        // the core treats it; the reverse-resolver case no longer arises
        // because the name's own resolver is not consulted.
        const runtime = runtimeWith({ text: fakeDryRunResult({ revert: true }) });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });

    test("a text call that fails is a failure", async () => {
        const runtime = runtimeWith({
            text: fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("RegistryCall");
    });

    test("a content resolver read that fails is a discovery failure", async () => {
        const runtime = createFakeContractRuntime({
            abi: DOTNS_PROTOCOL_REGISTRY_ABI,
            onQuery: () => fakeDryRunResult({ failure: { type: "ContractTrapped" } }),
        });
        const r = await getProfile("alice", { runtime, tld: DOT_TLD });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("AddressDiscovery");
    });

    test("a runtime that throws is a failure carrying the cause", async () => {
        const boom = new Error("socket closed");
        const runtime = createFakeContractRuntime({
            abi: [...DOTNS_PROTOCOL_REGISTRY_ABI, ...DOTNS_CONTENT_RESOLVER_ABI],
            onQuery: ({ functionName }) => {
                if (functionName === "get") return CONTENT_RESOLVER;
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

describe("verifyPublishedProfile", () => {
    const opts = (runtime: ReturnType<typeof runtimeWith>) => ({ runtime, tld: DOT_TLD });

    test("true when the resolver holds exactly the text, whatever the whitespace around it", async () => {
        const runtime = runtimeWith({ text: ` ${RECORD}\n` });
        expect(await verifyPublishedProfile("alice", RECORD, opts(runtime))).toEqual({
            ok: true,
            value: true,
        });
        expect(calls(runtime)).toEqual([GET, TEXT]);
    });

    test("false when the resolver holds another record, or none", async () => {
        expect(
            await verifyPublishedProfile("alice", RECORD, opts(runtimeWith({ text: "AA==" }))),
        ).toEqual({ ok: true, value: false });
        expect(
            await verifyPublishedProfile("alice", RECORD, opts(runtimeWith({ text: "" }))),
        ).toEqual({ ok: true, value: false });
    });

    test("an empty text asks whether the record is cleared", async () => {
        expect(await verifyPublishedProfile("alice", "", opts(runtimeWith({ text: "" })))).toEqual({
            ok: true,
            value: true,
        });
        expect(
            await verifyPublishedProfile("alice", "", opts(runtimeWith({ text: RECORD }))),
        ).toEqual({ ok: true, value: false });
    });

    test("a deployment with no content resolver holds nothing, so only a clear is published", async () => {
        const runtime = runtimeWith({ contentResolver: ZERO });
        expect(await verifyPublishedProfile("alice", "", opts(runtime))).toEqual({
            ok: true,
            value: true,
        });
        expect(await verifyPublishedProfile("alice", RECORD, opts(runtime))).toEqual({
            ok: true,
            value: false,
        });
    });

    test("a chain that cannot be asked is an error, not a false", async () => {
        const runtime = runtimeWith({ text: fakeDryRunResult({ failure: "boom" }) });
        const r = await verifyPublishedProfile("alice", RECORD, opts(runtime));
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toBeInstanceOf(DotNsError);
    });
});

describe("getProfileRecord", () => {
    const opts = (runtime: ReturnType<typeof runtimeWith>) => ({ runtime, tld: DOT_TLD });

    test("answers the text as stored, trimmed, whether or not it is a profile", async () => {
        expect(
            await getProfileRecord("alice", opts(runtimeWith({ text: ` ${RECORD}\n` }))),
        ).toEqual({ ok: true, value: RECORD });
        expect(
            await getProfileRecord("alice", opts(runtimeWith({ text: PRE_RFC_RECORD }))),
        ).toEqual({ ok: true, value: PRE_RFC_RECORD });
    });

    test("an empty string for a name with no record, or a deployment with no content resolver", async () => {
        expect(await getProfileRecord("alice", opts(runtimeWith({ text: "" })))).toEqual({
            ok: true,
            value: "",
        });
        const runtime = runtimeWith({ contentResolver: ZERO });
        expect(await getProfileRecord("alice", opts(runtime))).toEqual({ ok: true, value: "" });
        expect(calls(runtime)).toEqual([GET]);
    });

    test("refuses a label the core would not resolve", async () => {
        const r = await getProfileRecord("Alice!", opts(runtimeWith({})));
        expect(r.ok ? null : r.error.reason).toBe("InvalidName");
    });
});
