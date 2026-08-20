// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The resolver's SS58 has to reach a `Consumers` key with no conversion, which is
 * why the last test chains both reads instead of asserting on a type: `account` is
 * `string` and `SS58String` carries an optional brand, so hex would satisfy both.
 *
 * Not named `dotns.test.ts` because the DotNS registry PR adds that path.
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
