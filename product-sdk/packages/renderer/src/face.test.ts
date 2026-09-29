// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The builders and the validator have to agree.
 *
 * Each half is checked on its own beside its own code. This file checks the
 * one property neither can: that a face the builders can produce is a face the
 * validator accepts, with no warnings either. A disagreement here means one of
 * the two has drifted from the protocol, and it would otherwise surface as a
 * blank card on a phone.
 */
import { describe, expect, test } from "vitest";

import { androidLimits } from "./limits.js";
import {
    archive,
    background,
    blendingMode,
    border,
    circle,
    fillHeight,
    fillWidth,
    height,
    margin,
    marginEach,
    minHeight,
    minWidth,
    opacity,
    padding,
    paddingEach,
    rounded,
    square,
    width,
} from "./modifiers.js";
import {
    box,
    button,
    column,
    effect,
    image,
    nil,
    row,
    spacer,
    str,
    text,
    textField,
} from "./nodes.js";
import { validateFace } from "./validate.js";

/** A card in the shape the first real product card takes. */
const card = column(
    [
        row([text("Polkadot", { style: "BodySmallRegular", color: "FgTertiary" })], {
            modifiers: [fillWidth()],
            horizontalArrangement: "SpaceBetween",
        }),
        row(
            [
                box([text("R", { style: "TitleMediumRegular", color: "FgPrimary" })], {
                    modifiers: [width(44), height(44), background("BgSurfaceContainer", circle())],
                    contentAlignment: "Center",
                }),
                spacer({ width: 12 }),
                column([
                    text("remyleberre.01", { style: "TitleMediumRegular", color: "FgPrimary" }),
                    text("6 of 10 games played", {
                        style: "BodySmallRegular",
                        color: "FgSecondary",
                    }),
                ]),
            ],
            { verticalAlignment: "Center" },
        ),
        button("Ping", { clickAction: "ping", variant: "Secondary" }),
    ],
    {
        modifiers: [fillWidth(), fillHeight(), padding(20), background("FgSuccess", rounded(20))],
        verticalArrangement: "SpaceBetween",
    },
);

describe("a card built with the builders", () => {
    test("validates clean, with nothing to warn about either", () => {
        const verdict = validateFace(card);
        expect(verdict.errors).toEqual([]);
        expect(verdict.warnings).toEqual([]);
    });

    test("is still clean when android's own bounds are enforced", () => {
        expect(validateFace(card, { host: androidLimits }).ok).toBe(true);
    });

    // A preview face reaches the host as a file in the worker archive, so JSON
    // is the form that actually ships.
    test("survives the round trip through JSON that a preview file takes", () => {
        expect(validateFace(JSON.stringify(card)).ok).toBe(true);
    });
});

describe("every builder agrees with the validator", () => {
    test("each node builder produces a node with no errors and no warnings", () => {
        const nodes = [
            nil(),
            str("x"),
            text("x"),
            column([]),
            row([]),
            box([]),
            spacer({ width: 1, height: 2 }),
            button("x", { clickAction: "a" }),
            textField({ text: "", valueChangeAction: "a" }),
            image(archive("pocket/logo.png")),
            effect("Rainbow", [nil()]),
        ];

        for (const node of nodes) {
            const verdict = validateFace(node);
            expect(verdict.errors, JSON.stringify(node)).toEqual([]);
            expect(verdict.warnings, JSON.stringify(node)).toEqual([]);
        }
    });

    test("each modifier builder produces a modifier with no errors and no warnings", () => {
        const modifiers = [
            padding(1),
            paddingEach({ top: 1, end: 2, bottom: 3, start: 4 }),
            margin(1, 2),
            marginEach({ top: 1, end: 2 }),
            background("FgPrimary"),
            background("FgPrimary", rounded(4)),
            border(1, "FgError", square()),
            width(1),
            height(1),
            minWidth(1),
            minHeight(1),
            fillWidth(),
            fillHeight(false),
            opacity(0),
            blendingMode("Multiply"),
        ];

        const verdict = validateFace(column([], { modifiers }));
        expect(verdict.errors).toEqual([]);
        expect(verdict.warnings).toEqual([]);
    });
});
