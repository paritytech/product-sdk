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
        0, // LegacyRoot (the tag alone isn't synchronous in react-reconciler
        // 0.33.0 — sync comes from the SyncLane used in mount/unmount below)
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
            // Render synchronously so onRender fires before mount() returns.
            // The public updateContainer schedules on the default lane (a
            // microtask), which (a) makes the first onRender land a tick late
            // and (b) lets a same-tick unmount() — which is sync — discard the
            // pending mount. updateContainerSync + flushSyncWork keeps mount and
            // unmount symmetric and gives the synchronous semantics this
            // renderer wants.
            reconciler.updateContainerSync(
                createElement(RendererProvider, { subscribeActions }, node),
                fiberRoot,
            );
            reconciler.flushSyncWork();
        },
        unmount() {
            unmounted = true;
            reconciler.updateContainerSync(null, fiberRoot);
            reconciler.flushSyncWork();
        },
    };
}
