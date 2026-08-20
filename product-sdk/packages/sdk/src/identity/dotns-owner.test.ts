// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `resolvePeopleUsernameOwner` returns what the storage yields.
 *
 * `Resources.UsernameOwnerOf` yields SS58, and `Resources.Consumers` is keyed by
 * SS58, so the owner this returns has to be usable as a `Consumers` key with no
 * conversion in between. That round trip is the regression this file exists to
 * hold, and the last test holds it by chaining both reads for real. A type cannot:
 * `account` is `string` and `SS58String` carries an optional brand, so hex
 * satisfies both. The resolver used to return hex, which made every account to
 * username round trip carry a manual conversion.
 *
 * Deliberately not named `dotns.test.ts`: the open DotNS registry PR adds a file
 * by that name, and two branches adding the same path collide.
 */
import { describe, expect, test } from "vitest";
import type { SS58String } from "polkadot-api";
import { accountIdBytes } from "@parity/product-sdk-address";
import { type ConsumersChain, lookupUsername } from "@parity/product-sdk-individuality";
import { type PeopleUsernameQueryApi, resolvePeopleUsernameOwner } from "./dotns.js";

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;

/** A double that records the key it was asked for. */
function fakePeopleApi(owner: SS58String | undefined) {
    const keys: Uint8Array[] = [];
    const api: PeopleUsernameQueryApi = {
        query: {
            Resources: {
                UsernameOwnerOf: {
                    getValue: async (key: Uint8Array) => {
                        keys.push(key);
                        return owner;
                    },
                },
            },
        },
    };
    return { api, keys };
}

describe("resolvePeopleUsernameOwner", () => {
    test("returns the SS58 the storage yielded, unconverted", async () => {
        const { api } = fakePeopleApi(ALICE);
        expect(await resolvePeopleUsernameOwner("alice.dot", api)).toBe(ALICE);
    });

    test("an unowned username is null", async () => {
        const { api } = fakePeopleApi(undefined);
        expect(await resolvePeopleUsernameOwner("nobody.dot", api)).toBeNull();
    });

    test("the username is UTF-8 encoded for the storage key", async () => {
        const { api, keys } = fakePeopleApi(ALICE);
        await resolvePeopleUsernameOwner("alice.dot", api);
        expect(keys[0]).toEqual(new TextEncoder().encode("alice.dot"));
    });

    test("the owner reaches the Consumers storage key unconverted", async () => {
        // The one assertion here that spans both reads: the resolver's output goes
        // straight into `lookupUsername` and has to arrive as the storage key
        // untouched. The recorded key is the guard, not a type: see the header.
        const { api } = fakePeopleApi(ALICE);
        const owner = await resolvePeopleUsernameOwner("alice.dot", api);
        expect(owner).not.toBeNull();
        if (owner === null) return;

        const keys: string[] = [];
        const chain: ConsumersChain = {
            individuality: {
                query: {
                    Resources: {
                        Consumers: {
                            async getValue(key) {
                                keys.push(key);
                                return undefined;
                            },
                        },
                    },
                },
            },
        };

        const result = await lookupUsername(chain, { account: owner });
        expect(result.ok).toBe(true);
        expect(keys).toEqual([ALICE]);
    });

    test("the returned owner still decodes to a 32-byte public key", async () => {
        // What `signMessageWithDotNsIdentity` needs to build a signer. SS58 to
        // bytes is one call; it used to go SS58 to hex to bytes.
        const { api } = fakePeopleApi(ALICE);
        const owner = await resolvePeopleUsernameOwner("alice.dot", api);
        expect(owner).not.toBeNull();
        if (owner === null) return;
        expect(accountIdBytes(owner)).toHaveLength(32);
    });
});
