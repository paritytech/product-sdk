// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { androidLimits, validateFace } from "@parity/product-sdk-renderer";
import { describe, expect, test } from "vitest";

import { type LoyaltyState, loyaltyFace, PREVIEW_STATES } from "./face.js";

/** Exactly what `write-faces.ts` writes, so the tests measure what ships. */
function preview(state: LoyaltyState): string {
    return `${JSON.stringify(loyaltyFace(state), null, 2)}\n`;
}

describe("the loyalty face", () => {
    // Every state the card can be in has to draw. A state that only appears
    // after ten stamps is exactly the one nobody checks by hand.
    test.each(Object.entries(PREVIEW_STATES))("%s draws with no errors", (_name, state) => {
        const verdict = validateFace(loyaltyFace(state));
        expect(verdict.errors).toEqual([]);
        expect(verdict.warnings).toEqual([]);
    });

    // The worker always sends a note and the preview states never carry one, so
    // without this the only shape that reaches a device is the untested one.
    test("the live shape, which carries a note, draws with no errors", () => {
        const verdict = validateFace(loyaltyFace({ stamps: 3, goal: 10, note: "2 presses" }));
        expect(verdict.errors).toEqual([]);
        expect(verdict.warnings).toEqual([]);
    });

    // The host measures the text it reads, and indented JSON is about three
    // times the compact tree. Measuring the tree here would pass faces the build
    // then refuses, so this checks the bytes that actually ship.
    test.each(Object.entries(PREVIEW_STATES))("%s fits android as written", (_name, state) => {
        const verdict = validateFace(preview(state as LoyaltyState), { host: androidLimits });
        expect(verdict.errors).toEqual([]);
    });

    // Guards the trap above rather than the face: a goal this size is well under
    // the cap as a tree and well over it as the indented text that ships.
    test("a face measured as a tree rather than as text would slip past the cap", () => {
        const runaway: LoyaltyState = { stamps: 0, goal: 300 };
        expect(validateFace(loyaltyFace(runaway), { host: androidLimits }).ok).toBe(true);
        expect(validateFace(preview(runaway), { host: androidLimits }).ok).toBe(false);
    });
});
