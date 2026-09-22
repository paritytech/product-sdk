// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The loyalty card's face, as a renderer tree.
 *
 * One module for two surfaces. The worker sends this live over the Pocket
 * manager, and `write-faces.ts` writes the same trees to the JSON files the
 * manifest's `preview` paths point at, which is what the host's approval sheet
 * draws before the card is added. Generated from one source rather than written
 * twice, because a sheet that disagrees with the card it is offering is worse
 * than no sheet.
 *
 * Every string here is ASCII. The host reads worker JS as Latin-1, and this ends
 * up inside that bundle.
 */
import {
    background,
    box,
    button,
    type ColorToken,
    column,
    fillWidth,
    height,
    padding,
    type RendererNode,
    rounded,
    row,
    spacer,
    text,
    width,
} from "@parity/product-sdk-renderer";

/** The card this worker publishes, as named in the manifest. */
export const CARD_ID = "loyalty";

/** The action id the face names, and the host reports when the button is pressed. */
export const STAMP_ACTION = "stamp";

/** Where the card holder stands. */
export interface LoyaltyState {
    /** Stamps collected. */
    stamps: number;
    /** Stamps needed for the reward. */
    goal: number;
    /**
     * A line the worker can redraw on its own cadence. The static faces leave it
     * out, which is what makes a live card look different from a picture.
     */
    note?: string;
}

const CARD_PADDING = 20;
const CARD_RADIUS = 20;
const STAMP_SIZE = 14;
const STAMP_RADIUS = 3;
const STAMP_GAP = 4;

/** The states the approval sheet is shown, and the test checks. */
export const PREVIEW_STATES: Record<string, LoyaltyState> = {
    empty: { stamps: 0, goal: 10 },
    partial: { stamps: 6, goal: 10 },
    complete: { stamps: 10, goal: 10 },
};

/**
 * Progress as a row of filled boxes.
 *
 * The vocabulary has no progress bar, and a row of boxes says the same thing in
 * something the host can draw. A box needs a width and a height, or it draws as
 * nothing at all.
 */
function stampRow(filled: number, total: number): RendererNode {
    const marks: RendererNode[] = [];
    for (let mark = 0; mark < total; mark += 1) {
        const color: ColorToken = mark < filled ? "FgSuccess" : "BgSurfaceNested";
        marks.push(
            box([], {
                modifiers: [
                    width(STAMP_SIZE),
                    height(STAMP_SIZE),
                    background(color, rounded(STAMP_RADIUS)),
                ],
            }),
        );
        if (mark < total - 1) marks.push(spacer({ width: STAMP_GAP }));
    }
    return row(marks, { verticalAlignment: "Center" });
}

export function loyaltyFace({ stamps, goal, note }: LoyaltyState): RendererNode {
    const done = stamps >= goal;
    return column(
        [
            row(
                [
                    text("Loyalty", { style: "TitleMediumRegular", color: "FgPrimary" }),
                    text(`${stamps} of ${goal}`, {
                        style: "BodySmallRegular",
                        color: "FgSecondary",
                    }),
                ],
                { modifiers: [fillWidth()], horizontalArrangement: "SpaceBetween" },
            ),
            stampRow(stamps, goal),
            text(note ?? (done ? "Reward ready" : "Buy one more to earn a stamp"), {
                style: "BodySmallRegular",
                color: done ? "FgSuccess" : "FgTertiary",
            }),
            button(done ? "Redeem" : "Stamp", {
                clickAction: STAMP_ACTION,
                variant: done ? "Primary" : "Secondary",
            }),
        ],
        {
            modifiers: [
                fillWidth(),
                padding(CARD_PADDING),
                background("BgSurfaceContainer", rounded(CARD_RADIUS)),
            ],
            verticalArrangement: "SpaceBetween",
        },
    );
}
