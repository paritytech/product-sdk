// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// @ts-expect-error React exposes no type for this, and `act` refuses without it.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { drawPocketCard } from "@parity/product-sdk-react-renderer";
import type { CardCleanup, CardDrawHandler, PocketCardPress } from "@parity/product-sdk-react-renderer";
import type { RendererNode } from "@parity/product-sdk-renderer";
import { act } from "react";
import { expect, test } from "vitest";

import { CARD_ID } from "./face.js";
import { LoyaltyCard } from "./worker.js";

/**
 * Stands in for the host's Pocket manager, driven the way the host drives one:
 * the card goes on screen, presses are reported, the card leaves again.
 */
function fakeHost() {
    const faces: RendererNode[] = [];
    let draw: CardDrawHandler | undefined;
    let report: ((action: PocketCardPress) => void) | undefined;
    let release: CardCleanup;

    const pocket = {
        drawCard(_cardId: string, handler: CardDrawHandler) {
            draw = handler;
            return { unsubscribe() {} };
        },
        subscribeCardAction(_cardId: string, callback: (action: PocketCardPress) => void) {
            report = callback;
            return { unsubscribe() {} };
        },
    };

    return {
        pocket,
        /** The last face the host was sent, which is what the user is looking at. */
        get onScreen(): RendererNode {
            const face = faces.at(-1);
            if (face === undefined) throw new Error("the host was sent no face");
            return face;
        },
        async show() {
            await act(async () => {
                release = await draw?.((face) => faces.push(face), {
                    cardId: CARD_ID,
                    payload: "0x",
                });
            });
        },
        async hide() {
            await act(async () => {
                release?.();
            });
        },
        async press() {
            await act(async () => {
                report?.({ actionId: clickActionOf(this.onScreen), payload: "0x" });
            });
        },
    };
}

/** The action id react-renderer minted for the button in the face on screen. */
function clickActionOf(face: RendererNode): string {
    const button = childrenOf(face).find((child) => child.tag === "Button");
    if (button === undefined) throw new Error("the face carries no button");
    return (button.value as { props: { clickAction: string } }).props.clickAction;
}

function childrenOf(node: RendererNode): RendererNode[] {
    return (node.value as { children?: RendererNode[] }).children ?? [];
}

/** The "6 of 10" line, which is the only place the stamp count is legible. */
function tallyOn(face: RendererNode): string {
    const texts = childrenOf(childrenOf(face)[0] as RendererNode);
    const tally = childrenOf(texts[1] as RendererNode)[0];
    return (tally?.value as { text: string }).text;
}

// The bug this pins cost a user their stamps. `drawPocketCard` builds a fresh
// renderer each time the card is shown and unmounts the tree when it leaves, so
// state held in a `useState` inside the card resets on every tab switch: six
// stamps collected, zero on the way home, with nothing on the device saying why.
// The state has to outlive the tree that draws it.
test("the stamps survive the card leaving the screen and coming back", async () => {
    const host = fakeHost();
    drawPocketCard(host.pocket, CARD_ID, <LoyaltyCard />);

    await host.show();
    expect(tallyOn(host.onScreen)).toBe("0 of 10");

    for (let press = 0; press < 6; press += 1) await host.press();
    expect(tallyOn(host.onScreen)).toBe("6 of 10");

    await host.hide();
    await host.show();

    expect(tallyOn(host.onScreen)).toBe("6 of 10");
});
