// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { CustomRendererNode } from "@parity/truapi";
import { describe, expect, it, vi } from "vitest";

import type { ChatCustomMessageRenderer } from "./rendererChatMessage.js";
import { matchChatCustomRenderers } from "./rendererChatMessage.js";

describe("matchChatCustomRenderers", () => {
    it("streams renderer updates, actions, and teardown", () => {
        let emitAction: ((actionId: string, payload: Uint8Array | undefined) => void) | undefined;
        const stopActions = vi.fn();
        const disposeRenderer = vi.fn();
        const renderedNode: CustomRendererNode = {
            tag: "Text",
            value: {
                modifiers: [],
                props: { style: "HeadlineLarge", color: "FgPrimary" },
                children: [{ tag: "String", value: { text: "Heads" } }],
            },
        };
        const receivedActions: Array<[string, Uint8Array | undefined]> = [];

        const renderer: ChatCustomMessageRenderer = (request, render) => {
            const stop = request.subscribeActions((actionId, payload) => {
                receivedActions.push([actionId, payload]);
            });
            render(renderedNode);
            return () => {
                stop();
                disposeRenderer();
            };
        };
        const handler = matchChatCustomRenderers({ result: renderer });
        const source = handler({
            messageId: "message-1",
            messageType: "result",
            payload: Uint8Array.of(1, 2),
            subscribeActions(callback) {
                emitAction = callback;
                return stopActions;
            },
        });
        const next = vi.fn();

        const subscription = source.subscribe({ next });
        emitAction?.("flip-again", Uint8Array.of(3));

        expect(next).toHaveBeenCalledWith(renderedNode);
        expect(receivedActions).toEqual([["flip-again", Uint8Array.of(3)]]);

        subscription.unsubscribe();
        subscription.unsubscribe();
        expect(stopActions).toHaveBeenCalledOnce();
        expect(disposeRenderer).toHaveBeenCalledOnce();
    });

    it("reports an unregistered message type", () => {
        const handler = matchChatCustomRenderers({});

        expect(() =>
            handler({
                messageId: "message-1",
                messageType: "unknown",
                payload: new Uint8Array(),
                subscribeActions: () => () => undefined,
            }),
        ).toThrow('No custom chat renderer registered for message type "unknown"');
    });
});
