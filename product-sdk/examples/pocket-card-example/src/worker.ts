// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The worker the manifest's `entrypoint` points at.
 *
 * The host keeps the render open for as long as the card is on screen, so this
 * redraws in place rather than answering once. That is the whole difference
 * between a card and a picture.
 */
import { getPocketManager } from "@parity/product-sdk-host";

import { CARD_ID, loyaltyFace, STAMP_ACTION } from "./face.js";

/** How often the card redraws while it is on screen. */
const REDRAW_MS = 1000;
const GOAL = 10;

const pocket = await getPocketManager();

if (pocket === null) {
    // Not in a host container. The card keeps whatever static face it was added
    // with, which is a narrower card rather than a broken one.
    console.log("no host container, so the card stays static");
} else {
    let stamps = 0;

    pocket.drawCard(CARD_ID, (send) => {
        let seconds = 0;
        const paint = () => {
            send(loyaltyFace({ stamps, goal: GOAL, note: `on screen for ${seconds}s` }));
        };

        paint();
        const timer = setInterval(() => {
            seconds += 1;
            paint();
        }, REDRAW_MS);

        // Returned to the host, which calls it when the card leaves the screen.
        // Without this the timer outlives the card and keeps sending faces into
        // a render nobody is watching.
        return () => clearInterval(timer);
    });

    // A rendered face is a one way stream. This is the only way back from it.
    pocket.subscribeCardAction(CARD_ID, (action) => {
        if (action.actionId !== STAMP_ACTION) return;
        stamps = stamps >= GOAL ? 0 : stamps + 1;
    });
}
