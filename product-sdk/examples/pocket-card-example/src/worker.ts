// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The worker the manifest's `entrypoint` points at.
 *
 * The host keeps the render open for as long as the card is on screen, so this
 * redraws in place rather than answering once. That is the whole difference
 * between a card and a picture.
 *
 * The press is what drives the redraw. A rendered face is a one way stream, so
 * the only way back is `subscribeCardAction`, and the only way forward is the
 * `send` the render was opened with. Keeping that sink is what lets an action
 * change the card, and it is the whole loop this example exists to show.
 */
import { getPocketManager } from "@parity/product-sdk-host";

import { CARD_ID, loyaltyFace, STAMP_ACTION } from "./face.js";

const GOAL = 10;

const pocket = await getPocketManager();

if (pocket === null) {
    // Not in a host container. The card keeps whatever static face it was added
    // with, which is a narrower card rather than a broken one.
    console.log("no host container, so the card stays static");
} else {
    let stamps = 0;
    let presses = 0;

    /**
     * Draws the card as it stands, or does nothing while it is off screen.
     *
     * Set when the host opens the render and cleared when it closes, so a press
     * arriving while the card is away is recorded and drawn when it returns
     * rather than sent into a render nobody is watching.
     */
    let repaint: (() => void) | null = null;

    pocket.drawCard(CARD_ID, (send) => {
        repaint = () => {
            send(
                loyaltyFace({
                    stamps,
                    goal: GOAL,
                    note: presses === 0 ? undefined : `${presses} presses this session`,
                }),
            );
        };
        repaint();

        return () => {
            repaint = null;
        };
    });

    pocket.subscribeCardAction(CARD_ID, (action) => {
        if (action.actionId !== STAMP_ACTION) return;
        presses += 1;
        stamps = stamps >= GOAL ? 0 : stamps + 1;
        repaint?.();
    });
}
