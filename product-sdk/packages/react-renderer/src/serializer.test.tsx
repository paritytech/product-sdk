// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// @ts-expect-error Untyped
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { MODIFIER_SCHEMA, NODE_SCHEMA, validateFace } from "@parity/product-sdk-renderer";
import type { ReactNode } from "react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { Box, Button, Column, Effect, Image, Row, Spacer, Text, TextField } from "./components.js";
import { createRenderer } from "./renderer.js";
import { SERIALIZED_MODIFIERS, SERIALIZED_NODES } from "./serializer.js";

async function serialize(element: ReactNode) {
    const onRender = vi.fn((_node: unknown) => {});
    const renderer = createRenderer({ onRender, subscribeActions: () => () => {} });

    await act(async () => {
        renderer.mount(element);
    });

    return onRender.mock.calls[onRender.mock.calls.length - 1]![0];
}

/**
 * The reason this package exists is to author trees a host can draw, so a node
 * type or a modifier the protocol has and this renderer has not is a hole a
 * product only discovers when it needs the missing one. Both tables are pinned
 * to the protocol's own vocabulary in `@parity/product-sdk-renderer`, so a
 * vocabulary that grows fails here rather than silently staying unreachable
 * from JSX.
 */
describe("vocabulary", () => {
    it("serializes every node type the protocol declares", () => {
        expect([...SERIALIZED_NODES].sort()).toEqual(Object.keys(NODE_SCHEMA).sort());
    });

    it("serializes every modifier the protocol declares", () => {
        expect([...SERIALIZED_MODIFIERS].sort()).toEqual(Object.keys(MODIFIER_SCHEMA).sort());
    });
});

/**
 * Each protocol node declares its own fields, and a host ignores every key it
 * does not declare. Emitting `children` on a node that has none is therefore
 * invisible at runtime and only shows up as a validator warning, which is
 * exactly how it went unnoticed.
 */
describe("node fields", () => {
    it("omits children from the nodes the protocol gives none", async () => {
        const node = await serialize(
            <Column>
                <Spacer height={8} />
                <TextField value="" onValueChange={vi.fn(() => {})} />
                <Image source={{ tag: "Archive", value: "logo.png" }} />
            </Column>,
        );

        const offenders = (node as any).value.children
            .filter((child: any) => "children" in child.value)
            .map((child: any) => child.tag);
        expect(offenders).toEqual([]);
    });

    it("omits modifiers from Effect, the one node the protocol gives none", async () => {
        const node = await serialize(
            <Effect effect="Rainbow">
                <Text>shiny</Text>
            </Effect>,
        );

        expect("modifiers" in (node as any).value).toBe(false);
    });

    it("builds a card the protocol validator accepts without a single warning", async () => {
        const node = await serialize(
            <Column padding={16} background="BgSurfaceMain" opacity={200}>
                <Row horizontalArrangement="SpaceBetween">
                    <Text style="TitleMediumRegular">Loyalty</Text>
                    <Image source={{ tag: "Bulletin", value: "bafy" }} fit="Cover" width={24} />
                </Row>
                <Spacer height={8} />
                <Effect effect="Rainbow">
                    <Text style="HeadlineLarge">12 points</Text>
                </Effect>
                <Box contentAlignment="Center">
                    <Button text="Redeem" onClick={vi.fn(() => {})} />
                </Box>
                <TextField value="" label="Code" onValueChange={vi.fn(() => {})} />
            </Column>,
        );

        expect(validateFace(node)).toEqual({ ok: true, errors: [], warnings: [] });
    });
});
