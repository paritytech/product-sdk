// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { createElement } from "react";

import type { RenderCallback, SubscribeAction } from "./context.js";
import { RendererProvider } from "./context.js";
import { noop } from "./helpers.js";
import type { Container } from "./reconciler.js";
import { reconciler } from "./reconciler.js";

function onError(error: Error): void {
    console.error("[product-sdk-react-renderer]", error);
}

type RendererParams = {
    onRender: RenderCallback;
    subscribeActions: SubscribeAction;
};

export function createRenderer({ onRender, subscribeActions }: RendererParams) {
    let unmounted = false;

    const container: Container = { onRender, children: [] };
    const fiberRoot = reconciler.createContainer(
        container,
        0, // LegacyRoot — synchronous rendering
        null,
        false,
        null,
        "",
        onError,
        onError,
        onError,
        noop,
    );

    return {
        mount(node: ReactNode) {
            if (unmounted) {
                throw new Error("Renderer is already unmounted");
            }
            reconciler.updateContainer(
                createElement(RendererProvider, { subscribeActions }, node),
                fiberRoot,
            );
        },
        unmount() {
            unmounted = true;
            reconciler.updateContainerSync(null, fiberRoot);
        },
    };
}
