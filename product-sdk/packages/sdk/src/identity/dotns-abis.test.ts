// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// Guards on the transcribed deployment table. These check the shape of the
// table, not that it names the live deployment: only a diff against
// `paritytech/dotns` `deployments/paseo-assethub/420420417.json` can do that,
// and it is a network fetch. See the comment on PASEO_ASSETHUB_DOTNS for the
// commit the values were copied from, and re-check it when bumping.
import { isValidH160 } from "@parity/product-sdk-address";
import { describe, expect, test } from "vitest";
import { PASEO_ASSETHUB_DOTNS } from "./dotns-abis.js";

describe("PASEO_ASSETHUB_DOTNS", () => {
    test("every entry is a well-formed H160", () => {
        for (const [name, address] of Object.entries(PASEO_ASSETHUB_DOTNS)) {
            expect(isValidH160(address), `${name} = ${address}`).toBe(true);
        }
    });

    test("no two entries share an address", () => {
        // Six addresses transcribed by hand: a duplicated paste is the
        // transcription error most likely to go unnoticed, because the wrong
        // contract still answers and only the decode looks odd.
        const entries = Object.entries(PASEO_ASSETHUB_DOTNS);
        const seen = new Map<string, string>();
        for (const [name, address] of entries) {
            const key = address.toLowerCase();
            expect(seen.get(key), `${name} duplicates ${seen.get(key)}`).toBeUndefined();
            seen.set(key, name);
        }
        expect(seen.size).toBe(entries.length);
    });

    test("the resolver and the reverse resolver are different contracts", () => {
        // Load-bearing beyond general distinctness: resolveDotNs decides whether
        // a node has a forward record by comparing the registry's resolver
        // pointer against the reverse resolver, so collapsing these two would
        // make every registered name look resolvable.
        expect(PASEO_ASSETHUB_DOTNS.resolver.toLowerCase()).not.toBe(
            PASEO_ASSETHUB_DOTNS.reverseResolver.toLowerCase(),
        );
    });
});
