// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `resolvePeopleUsernameOwner` returns what the storage yields.
 *
 * `Resources.UsernameOwnerOf` yields SS58, and `Resources.Consumers` is keyed by
 * SS58, so the owner this returns has to be usable as a `Consumers` key with no
 * conversion in between. That round trip is the last test here, and it is the
 * regression this file exists to hold: the resolver used to return `0x` hex,
 * which made every account to username round trip carry a manual conversion.
 *
 * Deliberately not named `dotns.test.ts`: the open DotNS registry PR adds a file
 * by that name, and two branches adding the same path collide.
 */
import { describe, expect, test } from "vitest";
import type { SS58String } from "polkadot-api";
import { accountIdBytes } from "@parity/product-sdk-address";
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

    test("the result is a Consumers key as it stands, with no conversion", async () => {
        // The point of the change. `Resources.Consumers` is keyed by the account,
        // so a caller chaining the two reads must be able to pass this straight
        // through. A hex return made this line a conversion site.
        const { api } = fakePeopleApi(ALICE);
        const owner = await resolvePeopleUsernameOwner("alice.dot", api);
        expect(owner).not.toBeNull();

        const consumersKeys: string[] = [];
        const consumers = {
            getValue: async (key: string) => {
                consumersKeys.push(key);
                return undefined;
            },
        };
        await consumers.getValue(owner as string);
        expect(consumersKeys[0]).toBe(ALICE);
    });

    test("the returned owner still decodes to a 32-byte public key", async () => {
        // What `signMessageWithDotNsIdentity` needs to build a signer. SS58 to
        // bytes is one call; it used to go SS58 to hex to bytes.
        const { api } = fakePeopleApi(ALICE);
        const owner = await resolvePeopleUsernameOwner("alice.dot", api);
        expect(accountIdBytes(owner as string)).toHaveLength(32);
    });
});
