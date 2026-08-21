// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Guards the identity export surface: what must be there, and what must stay gone.
 */
import { describe, expect, it } from "vitest";
import * as identity from "./index.js";

describe("the identity export surface", () => {
    // Both sets threw or misled on every call, so no working consumer could
    // exist. Deleting turns a runtime problem into a compile error.
    it("no longer exports the ring stubs or the context-alias helpers", () => {
        for (const name of [
            "deriveAnonymousAlias",
            "createRingProof",
            "verifyRingProof",
            "deriveContextAlias",
            "verifyContextAlias",
        ]) {
            expect(name in identity).toBe(false);
        }
    });

    it("still exports the DotNS helpers", () => {
        for (const name of [
            "resolveDotNs",
            "reverseDotNs",
            "isDotNsAvailable",
            "resolvePeopleUsernameOwner",
            "isValidDotNsName",
            "normalizeDotNsName",
            "accountIdHexToBytes",
            "accountIdToHex",
        ]) {
            expect(name in identity).toBe(true);
        }
    });
});
