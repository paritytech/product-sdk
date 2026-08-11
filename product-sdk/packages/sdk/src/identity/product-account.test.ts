// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Frozen vectors for the deprecated context-alias helpers.
 *
 * These pin current behaviour so the deprecation cannot silently alter the
 * derivation. Never re-derive: a caller may use the value as a plain
 * identifier, where different output bytes would be a silent break.
 */
import { ss58Decode, ss58Encode } from "@parity/product-sdk-address";
import { blake2b256 } from "@parity/product-sdk-crypto";
import { describe, expect, it } from "vitest";
import * as identity from "./index.js";
import { deriveContextAlias, verifyContextAlias } from "./product-account.js";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CONTEXT = "voting-round-1";

/** Recomputes the documented formula from primitives, independent of the implementation. */
function expectedAliasPublicKey(parentAddress: string, context: string): Uint8Array {
    const { publicKey } = ss58Decode(parentAddress);
    const contextBytes = new TextEncoder().encode(context);
    const combined = new Uint8Array(publicKey.length + contextBytes.length);
    combined.set(publicKey, 0);
    combined.set(contextBytes, publicKey.length);
    return blake2b256(combined);
}

describe("deriveContextAlias", () => {
    it("returns blake2b256(parentPublicKey || context), encoded at the given prefix", () => {
        const alias = deriveContextAlias(ALICE, CONTEXT);
        const expected = expectedAliasPublicKey(ALICE, CONTEXT);

        expect(alias.address).toBe(ss58Encode(expected, 42));
    });

    it("matches a frozen vector for a known parent and context", () => {
        const alias = deriveContextAlias(ALICE, CONTEXT);

        expect(alias.address).toBe("5GPTdhxkG9wNKhCSN1vZrCwrf3fwvAf4j487vqrkVzvRMH6F");
        expect(alias.h160Address).toBe("0x93d10a91de267ba79b27fbec373e5a3b2e86a283");
        expect(alias.parentAddress).toBe(ALICE);
        expect(alias.context).toBe(CONTEXT);
    });

    it("defaults to ss58 prefix 42", () => {
        expect(deriveContextAlias(ALICE, CONTEXT).address).toBe(
            deriveContextAlias(ALICE, CONTEXT, 42).address,
        );
    });

    it("changes only the encoding when the ss58 prefix changes, not the key", () => {
        const at42 = deriveContextAlias(ALICE, CONTEXT, 42);
        const at0 = deriveContextAlias(ALICE, CONTEXT, 0);

        expect(at0.address).not.toBe(at42.address);
        expect(Array.from(ss58Decode(at0.address).publicKey)).toEqual(
            Array.from(ss58Decode(at42.address).publicKey),
        );
    });

    it("derives a different alias for a different context", () => {
        expect(deriveContextAlias(ALICE, "round-1").address).not.toBe(
            deriveContextAlias(ALICE, "round-2").address,
        );
    });
});

describe("verifyContextAlias", () => {
    it("accepts an alias derived from the same parent and context", () => {
        const alias = deriveContextAlias(ALICE, CONTEXT);

        expect(verifyContextAlias(alias.address, ALICE, CONTEXT)).toBe(true);
    });

    it("rejects a different context", () => {
        const alias = deriveContextAlias(ALICE, CONTEXT);

        expect(verifyContextAlias(alias.address, ALICE, "voting-round-2")).toBe(false);
    });

    it("rejects a different parent", () => {
        const alias = deriveContextAlias(ALICE, CONTEXT);
        const bob = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

        expect(verifyContextAlias(alias.address, bob, CONTEXT)).toBe(false);
    });

    it("returns false rather than throwing on an undecodable address", () => {
        expect(verifyContextAlias("not-an-address", ALICE, CONTEXT)).toBe(false);
    });

    // Guards the byte-level comparison: `addressesEqual` from
    // @parity/product-sdk-address compares SS58 strings exactly and would
    // return false here, silently narrowing behaviour.
    it("compares public keys, so it accepts an alias encoded at another prefix", () => {
        const alias = deriveContextAlias(ALICE, CONTEXT, 42);
        const reencoded = ss58Encode(ss58Decode(alias.address).publicKey, 0);

        expect(reencoded).not.toBe(alias.address);
        expect(verifyContextAlias(reencoded, ALICE, CONTEXT)).toBe(true);
    });
});

describe("the identity export surface", () => {
    // These threw on every call, so no working consumer could exist. Deleting
    // turns a guaranteed runtime throw into a compile error.
    it("no longer exports the unimplemented ring helpers", () => {
        for (const name of ["deriveAnonymousAlias", "createRingProof", "verifyRingProof"]) {
            expect(name in identity).toBe(false);
        }
    });

    it("still exports the DotNS helpers and the deprecated context-alias pair", () => {
        for (const name of [
            "resolveDotNs",
            "reverseDotNs",
            "isDotNsAvailable",
            "resolvePeopleUsernameOwner",
            "isValidDotNsName",
            "normalizeDotNsName",
            "accountIdHexToBytes",
            "deriveContextAlias",
            "verifyContextAlias",
        ]) {
            expect(name in identity).toBe(true);
        }
    });
});
