// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { validateFace } from "@parity/product-sdk-renderer";
import type { RendererNode } from "@parity/truapi";
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

/**
 * Reports what the protocol forbids, and what it allows and no product means,
 * before the tree reaches the host.
 *
 * Deliberately never throws. This runs inside the reconciler's commit, where
 * an exception leaves React with a half-applied tree it cannot recover from,
 * and an unreadable card is a far smaller problem than a stuck renderer.
 */
function reportIssues(node: RendererNode): void {
    const { errors, warnings } = validateFace(node);
    for (const issue of [...errors, ...warnings]) {
        console.error(
            `[product-sdk-react-renderer] ${issue.code} at ${issue.path || "<root>"}: ${issue.message}`,
        );
    }
}

type RendererParams = {
    onRender: RenderCallback;
    subscribeActions: SubscribeAction;
    /**
     * Check every tree against the renderer protocol and report what is wrong.
     * Off by default: this package is published, and turning a check on under
     * a consumer would fill a console they never asked to have written to.
     */
    validate?: boolean;
};

export function createRenderer({ onRender, subscribeActions, validate = false }: RendererParams) {
    let unmounted = false;

    const render: RenderCallback = validate
        ? (node) => {
              reportIssues(node);
              onRender(node);
          }
        : onRender;

    const container: Container = { onRender: render, children: [] };
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
