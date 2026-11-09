// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The write preparation through `createFakeContractRuntime`: the real ABI
// codec, no chain. The TLD is supplied so the walk starts at the protocol
// registry.
import { ss58ToH160 } from "@parity/product-sdk-address";
import { createFakeContractRuntime, fakeDryRunResult } from "@parity/product-sdk-contracts/testing";
import type { BuiltContractCall } from "@parity/product-sdk-contracts/testing";
import { describe, expect, test } from "vitest";

import {
    DOTNS_ADDRESSES,
    DOTNS_CONTENT_RESOLVER_ABI,
    DOTNS_CONTENT_RESOLVER_WRITE_ABI,
    DOTNS_PROTOCOL_REGISTRY_ABI,
    DOTNS_REGISTRY_ABI,
} from "../identity/dotns-abis.js";
import { DOTNS_CONTENT_RESOLVER_KEY, ZERO_ADDRESS as ZERO } from "../identity/dotns-addresses.js";
import { DOT_TLD, namehash } from "../identity/dotns-namehash.js";
import { PROFILE_TEXT_RECORD_KEY } from "./types.js";
import { prepareSetProfile } from "./write.js";

const CONTENT_RESOLVER = "0x3333333333333333333333333333333333333333";
/** The account the registry authorises for the name. */
const SIGNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as const;

// The record `record.test.ts` pins: avatar (cid, webp) + name "Alice".
const RECORD = "CIgAC9G7V+P56oAZVqdw/hBo+VA4NUespF4dPTVNV9AUywwCHAEUQWxpY2U=";

/**
 * A runtime whose view calls answer from `answers`, keyed by function name,
 * and which records what `.prepare()` built.
 */
function runtimeWith(answers: Record<string, unknown>) {
    const built: BuiltContractCall[] = [];
    const runtime = createFakeContractRuntime({
        abi: [
            ...DOTNS_PROTOCOL_REGISTRY_ABI,
            ...DOTNS_CONTENT_RESOLVER_ABI,
            ...DOTNS_CONTENT_RESOLVER_WRITE_ABI,
            ...DOTNS_REGISTRY_ABI,
        ],
        onQuery: ({ functionName, args }) => {
            if (functionName === "get") {
                return String(args?.[0]) === DOTNS_CONTENT_RESOLVER_KEY
                    ? (answers.contentResolver ?? CONTENT_RESOLVER)
                    : ZERO;
            }
            return functionName && functionName in answers ? answers[functionName] : undefined;
        },
        onCall: (call) => built.push(call),
    });
    return { runtime, built };
}

/** `name@dest` per call, the address lower-cased: the fake reports it as calldata carries it. */
const calls = (runtime: ReturnType<typeof runtimeWith>["runtime"]) =>
    runtime.calls.map((c) => `${c.functionName}@${c.dest.toLowerCase()}`);
const at = (address: string) => address.toLowerCase();
const GET = `get@${at(DOTNS_ADDRESSES.protocolRegistry)}`;
const IS_AUTHORISED = `isAuthorised@${at(DOTNS_ADDRESSES.registry)}`;
const TEXT = `text@${at(CONTENT_RESOLVER)}`;
const SET_TEXT = `setText@${at(CONTENT_RESOLVER)}`;

const opts = (runtime: ReturnType<typeof runtimeWith>["runtime"], origin?: string) => ({
    runtime,
    tld: DOT_TLD,
    ...(origin ? { origin } : {}),
});

const authorised = (answers: Record<string, unknown> = {}) =>
    runtimeWith({ isAuthorised: true, text: "", ...answers });

describe("prepareSetProfile", () => {
    test("prepares setText on the content resolver, sized by a dry-run as the origin", async () => {
        const { runtime, built } = authorised();
        const r = await prepareSetProfile("alice", RECORD, opts(runtime, SIGNER));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toMatchObject({ original: "", text: RECORD });
        expect(r.value.call).toBeDefined();
        // The authorisation and the current text are asked for together; the
        // dry-run waits on both. The node's resolver is never read or repointed.
        expect(calls(runtime)).toEqual([GET, IS_AUTHORISED, TEXT, SET_TEXT]);
        // viem checksums the decoded address, so compare it case-insensitively.
        const check = runtime.calls[1]?.args?.map((arg) => String(arg).toLowerCase());
        expect(check).toEqual([namehash("alice.dot", DOT_TLD), ss58ToH160(SIGNER).toLowerCase()]);
        const dryRun = runtime.calls.at(-1);
        expect(dryRun?.origin).toBe(SIGNER);
        expect(dryRun?.args).toEqual([
            namehash("alice.dot", DOT_TLD),
            PROFILE_TEXT_RECORD_KEY,
            RECORD,
        ]);
        expect(built.map((c) => c.dest.toLowerCase())).toEqual([at(CONTENT_RESOLVER)]);
    });

    test("carries the text the resolver holds now, for the re-read before submitting", async () => {
        const { runtime } = authorised({ text: RECORD });
        const r = await prepareSetProfile("alice", "AA==", opts(runtime, SIGNER));
        expect(r.ok && r.value.original).toBe(RECORD);
    });

    test("an empty text clears the record", async () => {
        const { runtime } = authorised({ text: RECORD });
        const r = await prepareSetProfile("alice", "  ", opts(runtime, SIGNER));
        expect(r.ok && r.value.text).toBe("");
        expect(runtime.calls.at(-1)?.args?.[2]).toBe("");
    });

    test("a lite username's parts are levels of the node, and the TLD is tolerated", async () => {
        const { runtime } = authorised();
        await prepareSetProfile("Alice.01.dot", RECORD, opts(runtime, SIGNER));
        expect(runtime.calls.at(-1)?.args?.[0]).toBe(namehash("alice.01.dot", DOT_TLD));
    });

    test("refuses a text no reader accepts before touching the chain", async () => {
        const { runtime } = authorised();
        const r = await prepareSetProfile("alice", "not base64!", opts(runtime, SIGNER));
        expect(r.ok ? null : r.error.reason).toBe("NotBase64");
        expect(runtime.calls).toHaveLength(0);
    });

    test("needs the owner as origin", async () => {
        const { runtime } = authorised();
        const r = await prepareSetProfile("alice", RECORD, opts(runtime));
        expect(r.ok ? null : r.error.reason).toBe("MissingOrigin");
        expect(runtime.calls).toHaveLength(0);
    });

    test("refuses an origin that is not an SS58 address", async () => {
        const { runtime } = authorised();
        const r = await prepareSetProfile("alice", RECORD, opts(runtime, "not-an-address"));
        expect(r.ok ? null : r.error.reason).toBe("InvalidOrigin");
        expect(runtime.calls).toHaveLength(0);
    });

    test("refuses a label no host resolves", async () => {
        const { runtime } = authorised();
        const r = await prepareSetProfile("Alice!", RECORD, opts(runtime, SIGNER));
        expect(r.ok ? null : r.error.reason).toBe("InvalidName");
        expect(runtime.calls).toHaveLength(0);
    });

    test("a deployment with no content resolver holds no profiles", async () => {
        const { runtime } = authorised({ contentResolver: ZERO });
        const r = await prepareSetProfile("alice", RECORD, opts(runtime, SIGNER));
        expect(r.ok ? null : r.error.reason).toBe("AddressDiscovery");
    });

    test("an origin the registry does not authorise is refused before the dry-run", async () => {
        // The registry answers false for a stranger and for a name nobody holds alike.
        const { runtime, built } = authorised({ isAuthorised: false });
        const r = await prepareSetProfile("alice", RECORD, opts(runtime, SIGNER));
        expect(r.ok ? null : r.error.reason).toBe("Unauthorised");
        expect(calls(runtime)).toEqual([GET, IS_AUTHORISED, TEXT]);
        expect(built).toHaveLength(0);
    });

    test("a failing authorisation read is an error, not a guessed answer", async () => {
        const { runtime } = authorised({ isAuthorised: fakeDryRunResult({ failure: "boom" }) });
        const r = await prepareSetProfile("alice", RECORD, opts(runtime, SIGNER));
        expect(r.ok ? null : r.error.reason).toBe("RegistryCall");
    });

    test("a dry-run that reverts is reported, not prepared", async () => {
        const { runtime, built } = authorised({
            setText: fakeDryRunResult({ revert: "NotAuthorised" }),
        });
        const r = await prepareSetProfile("alice", RECORD, opts(runtime, SIGNER));
        expect(r.ok ? null : r.error.reason).toBe("RegistryCall");
        expect(r.ok ? null : r.error.cause).toBeDefined();
        expect(built).toHaveLength(0);
    });
});
