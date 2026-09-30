// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Mount a face once and hand back the tree it produced.
 *
 * The preview generator and the tests both want a finished tree rather than a
 * live stream. Reading the *last* frame before unmounting matters: unmount
 * emits `Nil`, so reading after it yields an empty face that validates clean
 * and tells you nothing.
 */
import { createRenderer } from "@parity/product-sdk-react-renderer";
import type { RendererNode } from "@parity/product-sdk-renderer";
import type { ReactNode } from "react";

export function renderOnce(element: ReactNode): RendererNode {
    const frames: RendererNode[] = [];
    const renderer = createRenderer({
        onRender: (node) => frames.push(node),
        subscribeActions: () => () => {},
    });

    renderer.mount(element);
    const mounted = frames.at(-1);
    renderer.unmount();

    if (mounted === undefined) throw new Error("the face produced no frame");
    return mounted;
}
