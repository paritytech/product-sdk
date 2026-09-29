// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Draw a Pocket card's face from a React tree.
 *
 * The host's Pocket manager and this renderer describe the same card in two
 * dialects. A face leaves as a `RendererNode` either way, but a press comes back
 * from the host as a hex payload on a handle that has to be unsubscribed, while
 * the renderer wants raw bytes and a plain teardown function. This module is the
 * translation between the two.
 *
 * The manager is taken structurally rather than imported, so that this package
 * keeps its independence from any transport and React stays out of
 * `@parity/product-sdk-host`. The types below mirror that package's own.
 *
 * @module
 */
import type { HexString, RendererNode } from "@parity/truapi";
import { hexToBytes } from "@parity/truapi/scale";
import type { ReactNode } from "react";

import { createRenderer } from "./renderer.js";

/** What a draw handler leaves behind: what runs when the card leaves the screen. */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler body that just draws returns void
export type CardCleanup = (() => void) | void;

/** Which card the host is asking for, and what it carried. */
export interface CardRender {
    cardId: string;
    payload: HexString;
}

/** Called when the host puts a card on screen, with the sink to draw into. */
export type CardDrawHandler = (
    send: (face: RendererNode) => void,
    render: CardRender,
) => CardCleanup | Promise<CardCleanup>;

/** Handle for one card's registration. */
export interface CardDrawRegistration {
    unsubscribe(): void;
}

/** A press or a value change inside a card's face, as the host reports it. */
export interface PocketCardAction {
    actionId: string;
    payload: HexString;
}

/**
 * The slice of the host's Pocket manager this needs. A real `PocketManager`
 * satisfies it, and so does anything else shaped like one.
 */
export interface PocketCardDrawer {
    drawCard(cardId: string, draw: CardDrawHandler): CardDrawRegistration;
    /** The host's handle carries more than this; only giving the subscription back matters here. */
    subscribeCardAction(
        cardId: string,
        callback: (action: PocketCardAction) => void,
    ): { unsubscribe(): void };
}

/**
 * A press carries nothing, which the host reports as an empty hex string. The
 * renderer spells that `undefined`, and its components read it that way.
 */
function decodePayload(payload: HexString): Uint8Array | undefined {
    return payload === "0x" ? undefined : hexToBytes(payload);
}

/**
 * Draw `cardId` from `element` for as long as the host keeps the card on screen.
 *
 * The tree stays live rather than answering once: state changes inside it redraw
 * the card through the same sink, and a press comes back to the handler that
 * asked for it. The host tears the tree down when the card leaves, and puts a
 * fresh one up if the card returns.
 */
export function drawPocketCard(
    pocket: PocketCardDrawer,
    cardId: string,
    element: ReactNode,
): CardDrawRegistration {
    return pocket.drawCard(cardId, (send) => {
        const renderer = createRenderer({
            onRender: send,
            subscribeActions: (callback) => {
                const subscription = pocket.subscribeCardAction(cardId, (action) => {
                    callback(action.actionId, decodePayload(action.payload));
                });
                return () => {
                    subscription.unsubscribe();
                };
            },
        });

        renderer.mount(element);

        return () => {
            renderer.unmount();
        };
    });
}
