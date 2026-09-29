// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The worker the manifest's `entrypoint` points at.
 *
 * The host keeps the render open for as long as the card is on screen, so this
 * redraws in place rather than answering once. That is the whole difference
 * between a card and a picture.
 *
 * Authoring in JSX is what makes that loop small. The card is a component with
 * state, so a press calls `setState` and React streams the next face through
 * the sink the host opened. Written against the tree directly, the same thing
 * needs a repaint closure that the render opens and the cleanup clears, plus
 * care not to send into a render nobody is watching.
 */
import { getPocketManager } from "@parity/product-sdk-host";
import { drawPocketCard } from "@parity/product-sdk-react-renderer";
import { useState } from "react";

import { CARD_ID, LoyaltyFace } from "./face.js";

const GOAL = 10;

function LoyaltyCard() {
    const [stamps, setStamps] = useState(0);
    const [presses, setPresses] = useState(0);

    return (
        <LoyaltyFace
            stamps={stamps}
            goal={GOAL}
            note={presses === 0 ? undefined : `${presses} presses this session`}
            onStamp={() => {
                setPresses((count) => count + 1);
                setStamps((count) => (count >= GOAL ? 0 : count + 1));
            }}
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
