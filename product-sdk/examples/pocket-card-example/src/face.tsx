// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The loyalty card's face, authored in JSX.
 *
 * One module for two surfaces. The worker mounts it live, and `write-faces.tsx`
 * mounts the same component to write the JSON the manifest's `preview` paths
 * point at, which is what the approval sheet draws before the card is added.
 * One source, so the sheet and the card cannot disagree.
 *
 * Every string here is ASCII. The host reads worker JS as Latin-1.
 */
import { Box, Button, Column, Row, Text } from "@parity/product-sdk-react-renderer";
import type { ReactNode } from "react";

/** The card this worker publishes, as named in the manifest. */
export const CARD_ID = "loyalty";

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

export interface LoyaltyFaceProps extends LoyaltyState {
        /**
     * Run when the button is pressed.
     *
     * Left out by the preview generator, which draws where nothing is
     * listening. react-renderer then emits no `clickAction`, so the face the
     * approval sheet reads names no action rather than one nothing registers.
     */
    onStamp?(): void;
}

/** The states the approval sheet is shown, and the test checks. */
export const PREVIEW_STATES: Record<string, LoyaltyState> = {
    empty: { stamps: 0, goal: 10 },
    partial: { stamps: 6, goal: 10 },
    complete: { stamps: 10, goal: 10 },
};

/**
 * Progress as a row of filled boxes, since the vocabulary has no progress bar.
 *
 * The gap is a margin rather than a `Spacer` between each box. Interleaving
 * spacers needs a keyed fragment per mark, which React warns about and which
 * reads worse than the thing it produces.
 */
function Stamps({ filled, total }: { filled: number; total: number }): ReactNode {
    return (
        <Row verticalAlignment="Center">
            {Array.from({ length: total }, (_, mark) => (
                <Box
                    key={mark}
                    width={STAMP_SIZE}
                    height={STAMP_SIZE}
                    // All four edges, deliberately: `Dimensions` is a shorthand
                    // where `start` falls back to `end` and `bottom` to `top`,
                    // so naming only `top` and `end` puts the gap on both sides
                    // of every box and pushes the row off centre.
                    margin={{
                        top: 0,
                        end: mark < total - 1 ? STAMP_GAP : 0,
                        bottom: 0,
                        start: 0,
                    }}
                    background={{
                        color: mark < filled ? "FgSuccess" : "BgSurfaceNested",
                        shape: { tag: "Rounded", value: STAMP_RADIUS },
                    }}
                />
            ))}
        </Row>
    );
}

export function LoyaltyFace({ stamps, goal, note, onStamp }: LoyaltyFaceProps): ReactNode {
    const done = stamps >= goal;
    return (
        <Column
            fillMaxWidth
            padding={CARD_PADDING}
            background={{ color: "BgSurfaceContainer", shape: { tag: "Rounded", value: CARD_RADIUS } }}
            verticalArrangement="SpaceBetween"
        >
            <Row fillMaxWidth horizontalArrangement="SpaceBetween">
                <Text style="TitleMediumRegular" color="FgPrimary">
                    Loyalty
                </Text>
                <Text style="BodySmallRegular" color="FgSecondary">
                    {`${stamps} of ${goal}`}
                </Text>
            </Row>

            <Stamps filled={stamps} total={goal} />

            <Text style="BodySmallRegular" color={done ? "FgSuccess" : "FgTertiary"}>
                {note ?? (done ? "Reward ready" : "Buy one more to earn a stamp")}
            </Text>

            <Button
                text={done ? "Redeem" : "Stamp"}
                variant={done ? "Primary" : "Secondary"}
                onClick={onStamp}
            />
        </Column>
    );
}
