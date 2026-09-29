// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// @ts-expect-error Untyped
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import type { HexString, RendererNode } from "@parity/truapi";
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";

import { Text } from "./components.js";
import { useAction } from "./context.js";
import type { CardCleanup, CardDrawHandler, PocketCardPress } from "./pocket.js";
import { drawPocketCard } from "./pocket.js";

const CARD_ID = "loyalty";

/**
 * Stands in for the host's Pocket manager, driven the way the host drives it:
 * the card goes on screen, a press is reported, the card leaves again.
 */
function makeFakeHost() {
    const faces: RendererNode[] = [];
    const unsubscribeActions = vi.fn();
    const unsubscribeDraw = vi.fn();

    let draw: CardDrawHandler | undefined;
    let report: ((action: PocketCardPress) => void) | undefined;
    let release: CardCleanup;

    const pocket = {
        drawCard(_cardId: string, handler: CardDrawHandler) {
            draw = handler;
            return { unsubscribe: unsubscribeDraw };
        },
        subscribeCardAction(_cardId: string, callback: (action: PocketCardPress) => void) {
            report = callback;
            return { unsubscribe: unsubscribeActions };
        },
    };

    async function putCardOnScreen() {
        await act(async () => {
            release = await draw?.((face) => faces.push(face), {
                cardId: CARD_ID,
                payload: "0x",
            });
        });
    }

    async function takeCardOffScreen() {
        await act(async () => {
            release?.();
        });
    }

    // Deliberately still live after `unsubscribe`: a face that has been taken
    // down has to ignore a late action on its own, not lean on the host to stop.
    async function reportAction(actionId: string, payload: HexString) {
        await act(async () => {
            report?.({ actionId, payload });
        });
    }

    return {
        pocket,
        faces,
        putCardOnScreen,
        takeCardOffScreen,
        reportAction,
        unsubscribeActions,
        unsubscribeDraw,
    };
}

/**
 * Surfaces the bytes an action carried. The host reports a payload as hex, and
 * the only thing that proves the decode is what the tree ends up holding.
 */
function PayloadProbe({ onPayload }: { onPayload: (payload: Uint8Array | undefined) => void }) {
    const clickAction = useAction((payload) => payload, onPayload);

    return createElement("Button", { text: "Stamp", clickAction });
}

function clickActionOf(face: RendererNode | undefined): string {
    return (face as any).value.props.clickAction;
}

describe("drawPocketCard", () => {
    it("draws the element into the sink the host opened the card with", async () => {
        const host = makeFakeHost();
        drawPocketCard(host.pocket, CARD_ID, <Text style="HeadlineLarge">3 of 10</Text>);

        await host.putCardOnScreen();

        expect(host.faces).toHaveLength(1);
        const face = host.faces[0] as any;
        expect(face.tag).toBe("Text");
        expect(face.value.props.style).toBe("HeadlineLarge");
        expect(face.value.children[0]).toEqual({ tag: "String", value: { text: "3 of 10" } });
    });

    it("hands a reported action's payload to the handler as the bytes its hex encodes", async () => {
        const seen: (Uint8Array | undefined)[] = [];
        const host = makeFakeHost();
        drawPocketCard(
            host.pocket,
            CARD_ID,
            <PayloadProbe onPayload={(payload) => seen.push(payload)} />,
        );

        await host.putCardOnScreen();
        await host.reportAction(clickActionOf(host.faces[0]), "0x68656c6c6f");

        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    });

    it("reports a press that carried nothing as no payload at all", async () => {
        const seen: (Uint8Array | undefined)[] = [];
        const host = makeFakeHost();
        drawPocketCard(
            host.pocket,
            CARD_ID,
            <PayloadProbe onPayload={(payload) => seen.push(payload)} />,
        );

        await host.putCardOnScreen();
        await host.reportAction(clickActionOf(host.faces[0]), "0x");

        // Not an empty byte array: a handler asks "did anything come back?", and
        // the renderer's own action contract spells that absence `undefined`.
        expect(seen).toEqual([undefined]);
    });

    it("unmounts the tree when the host takes the card off screen", async () => {
        const seen: (Uint8Array | undefined)[] = [];
        const host = makeFakeHost();
        drawPocketCard(
            host.pocket,
            CARD_ID,
            <PayloadProbe onPayload={(payload) => seen.push(payload)} />,
        );

        await host.putCardOnScreen();
        const clickAction = clickActionOf(host.faces[0]);

        await host.takeCardOffScreen();

        expect((host.faces[host.faces.length - 1] as any).tag).toBe("Nil");
        expect(host.unsubscribeActions).toHaveBeenCalledTimes(1);

        await host.reportAction(clickAction, "0x01");
        expect(seen).toHaveLength(0);
    });

    // The host's own registration only stops future draws. Without this the tree
    // stays mounted and keeps sending faces into a body nobody is watching.
    it("unmounts a card that is on screen when the registration is given up", async () => {
        const host = makeFakeHost();
        const registration = drawPocketCard(
            host.pocket,
            CARD_ID,
            createElement(Text, null, "Live"),
        );

        await host.putCardOnScreen();
        expect(host.faces).toHaveLength(1);

        await act(async () => {
            registration.unsubscribe();
        });

        expect(host.unsubscribeDraw).toHaveBeenCalledTimes(1);
        expect(host.faces.at(-1)).toEqual({ tag: "Nil" });
    });

    // The payload the host echoes back with the draw request is otherwise
    // unreachable, since the element is captured before any draw happens.
    it("gives the element the render request when it is a function", async () => {
        const host = makeFakeHost();
        drawPocketCard(host.pocket, CARD_ID, (render) => createElement(Text, null, render.cardId));

        await host.putCardOnScreen();

        expect(JSON.stringify(host.faces[0])).toContain(CARD_ID);
    });
});
