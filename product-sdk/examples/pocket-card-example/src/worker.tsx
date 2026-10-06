// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The worker the manifest's `entrypoint` points at.
 *
 * The host keeps the render open for as long as the card is on screen, so this
 * redraws in place rather than answering once. That is the whole difference
 * between a card and a picture.
 *
 * Authoring in JSX is what makes that loop small. A press updates the card and
 * React streams the next face through the sink the host opened. Written against
 * the tree directly, the same thing needs a repaint closure that the render
 * opens and the cleanup clears.
 *
 * What the JSX does not change is where the card's state belongs. `drawPocketCard`
 * builds a fresh renderer every time the host puts the card on screen and tears
 * the tree down when the card leaves, so a `useState` inside `LoyaltyCard` is
 * lost the moment the user switches tabs: six stamps in, back to zero on the way
 * home. The stamps are the holder's, not the render's, so they live at module
 * scope and the tree subscribes to them for as long as it is up.
 */
import { getPocketManager } from "@parity/product-sdk-host";
import { drawPocketCard } from "@parity/product-sdk-react-renderer";
import { useSyncExternalStore } from "react";

import { CARD_ID, LoyaltyFace } from "./face.js";

const GOAL = 10;

interface CardState {
    stamps: number;
    presses: number;
}

let card: CardState = { stamps: 0, presses: 0 };
const watchers = new Set<() => void>();

// A whole new record rather than a mutation: `useSyncExternalStore` decides
// whether to redraw by comparing what it read last with what it reads now.
function stamp(): void {
    card = {
        stamps: card.stamps >= GOAL ? 0 : card.stamps + 1,
        presses: card.presses + 1,
    };
    for (const watcher of watchers) watcher();
}

function watchCard(onChange: () => void): () => void {
    watchers.add(onChange);
    return () => {
        watchers.delete(onChange);
    };
}

function readCard(): CardState {
    return card;
}

/** Exported so `worker.test.tsx` can put it on a fake host and take it off again. */
export function LoyaltyCard() {
    const { stamps, presses } = useSyncExternalStore(watchCard, readCard);

    return (
        <LoyaltyFace
            stamps={stamps}
            goal={GOAL}
            note={presses === 0 ? undefined : `${presses} presses this session`}
            onStamp={stamp}
        />
    );
}

const pocket = await getPocketManager();

if (pocket === null) {
    // Not in a host container. The card keeps whatever static face it was added
    // with, which is a narrower card rather than a broken one.
    console.log("no host container, so the card stays static");
} else {
    // Everything the host needs is here: the registration, the action stream and
    // the mount and unmount pairing. The adapter between the host's hex payload
    // and the renderer's bytes lives in the SDK rather than in every worker.
    drawPocketCard(pocket, CARD_ID, <LoyaltyCard />);
}
