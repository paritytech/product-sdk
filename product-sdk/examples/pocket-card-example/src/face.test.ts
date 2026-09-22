// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { androidLimits, validateFace } from "@parity/product-sdk-renderer";
import { describe, expect, test } from "vitest";

import { type LoyaltyState, loyaltyFace, PREVIEW_STATES } from "./face.js";

describe("the loyalty face", () => {
    // Every state the card can be in has to draw. A state that only appears
    // after ten stamps is exactly the one nobody checks by hand.
    test.each(Object.entries(PREVIEW_STATES))("%s draws with no errors", (_name, state) => {
        const verdict = validateFace(loyaltyFace(state as LoyaltyState));
        expect(verdict.errors).toEqual([]);
        expect(verdict.warnings).toEqual([]);
    });

    test("every state fits what the android host will draw", () => {
        for (const state of Object.values(PREVIEW_STATES)) {
            expect(validateFace(loyaltyFace(state), { host: androidLimits }).ok).toBe(true);
        }
    });
});
