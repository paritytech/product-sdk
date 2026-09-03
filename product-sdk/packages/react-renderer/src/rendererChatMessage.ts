// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { CustomRendererNode, ObservableSource } from "@parity/truapi";
import type { ReactNode } from "react";

import { createRenderer } from "./renderer.js";

/**
 * Parameters passed to a chat custom message renderer. Structurally matches
 * the host-side rendering request contract so any transport implementation
 * can invoke the callback.
 */
export type ChatCustomMessageRendererParams<T = Uint8Array> = {
    messageId: string;
    messageType: string;
    payload: T;
    subscribeActions(
        callback: (actionId: string, payload: Uint8Array | undefined) => void,
    ): VoidFunction;
};

/** Callback invoked by the host transport to render a custom chat message. */
export type ChatCustomMessageRenderer = (
    params: ChatCustomMessageRendererParams,
    render: (node: CustomRendererNode) => void,
) => VoidFunction;

/** Product callback that streams renderer trees for one custom chat message. */
export type ChatCustomMessageRenderingRequestHandler = (
    request: ChatCustomMessageRendererParams,
) => ObservableSource<CustomRendererNode>;

/**
 * Register a React-based renderer for custom chat messages.
 *
 * @param mapPayload - Map function to convert the payload to the desired type.
 * @param renderFn - Receives message params and returns a React element tree.
 * @returns A callback compatible with a chat custom message rendering request handler.
 */
export function registerChatMessageRenderer<Payload>(
    mapPayload: (payload: Uint8Array) => Payload,
    renderFn: (
        params: Omit<ChatCustomMessageRendererParams<NoInfer<Payload>>, "subscribeActions">,
    ) => ReactNode,
): ChatCustomMessageRenderer {
    return ({ messageId, messageType, payload, subscribeActions }, render) => {
        const renderer = createRenderer({ onRender: render, subscribeActions });

        renderer.mount(renderFn({ messageId, messageType, payload: mapPayload(payload) }));

        return () => {
            renderer.unmount();
        };
    };
}

/** Select a registered renderer using the custom message's product-defined type. */
export function matchChatCustomRenderers(
    renderers: Readonly<Record<string, ChatCustomMessageRenderer>>,
): ChatCustomMessageRenderingRequestHandler {
    return (request) => {
        const renderer = renderers[request.messageType];
        if (!renderer) {
            throw new Error(
                `No custom chat renderer registered for message type "${request.messageType}"`,
            );
        }

        return {
            subscribe(observer) {
                let active = true;
                const dispose = renderer(request, (node) => {
                    if (active) observer.next?.(node);
                });

                return {
                    unsubscribe() {
                        if (!active) return;
                        active = false;
                        dispose();
                    },
                };
            },
        };
    };
}
