// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// @ts-expect-error Untyped
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, expect, it, vi } from "vitest";
import { act, useState } from "react";

import { Button, Column, Spacer, Text } from "./components.js";
import type { ActionCallback } from "./context.js";
import { createRenderer } from "./renderer.js";

/**
 * Creates a simple action bus that captures the subscriber callback so tests
 * can dispatch actions (simulating the host firing ActionTriggered events).
 */
function makeActionBus() {
    let listener: ActionCallback | undefined;

    const subscribeActions = vi.fn((cb: ActionCallback) => {
        listener = cb;
        return () => {
            listener = undefined;
        };
    });

    function dispatch(actionId: string, payload?: Uint8Array) {
        listener?.(actionId, payload);
    }

    return { subscribeActions, dispatch };
}

describe("createRenderer", () => {
    it("returns an object with mount and unmount methods", () => {
        const { subscribeActions } = makeActionBus();
        const renderer = createRenderer({
            onRender: vi.fn(() => {}),
            subscribeActions,
        });
        expect(typeof renderer.mount).toBe("function");
        expect(typeof renderer.unmount).toBe("function");
    });

    it("calls onRender with the serialized node after mount", async () => {
        const onRender = vi.fn((_node: unknown) => {});
        const { subscribeActions } = makeActionBus();

        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(
                <Text style="HeadlineLarge" color="FgPrimary">
                    Hello
                </Text>,
            );
        });

        expect(onRender).toHaveBeenCalledTimes(1);
        const node = onRender.mock.calls[0]![0] as any;
        expect(node.tag).toBe("Text");
        expect(node.value.props.style).toBe("HeadlineLarge");
        expect(node.value.props.color).toBe("FgPrimary");
        expect(node.value.children[0]).toEqual({
            tag: "String",
            value: { text: "Hello" },
        });
    });

    it("renders Nil when node is null", async () => {
        const onRender = vi.fn((_node: unknown) => {});
        const { subscribeActions } = makeActionBus();

        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(null);
        });

        const node = onRender.mock.calls[0]![0] as any;
        expect(node.tag).toBe("Nil");
    });

    it("serializes a nested tree with layout modifiers", async () => {
        const onRender = vi.fn((_node: unknown) => {});
        const { subscribeActions } = makeActionBus();

        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(
                <Column padding={16} horizontalAlignment="Center">
                    <Text style="BodyMediumRegular">Label</Text>
                    <Spacer />
                </Column>,
            );
        });

        const node = onRender.mock.calls[0]![0] as any;
        expect(node.tag).toBe("Column");
        expect(node.value.props.horizontalAlignment).toBe("Center");
        const paddingMod = (node.value.modifiers as any[]).find((m: any) => m.tag === "Padding");
        expect(paddingMod.value).toEqual({ top: 16, end: 16 });
        expect(node.value.children).toHaveLength(2);
        expect(node.value.children[0].tag).toBe("Text");
        expect(node.value.children[1].tag).toBe("Spacer");
    });

    it("wraps multiple root siblings in a Column", async () => {
        const onRender = vi.fn((_node: unknown) => {});
        const { subscribeActions } = makeActionBus();

        // A React fragment produces two sibling nodes at the container root.
        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(
                <>
                    <Text>First</Text>
                    <Text>Second</Text>
                </>,
            );
        });

        const node = onRender.mock.calls[0]![0] as any;
        expect(node.tag).toBe("Column");
        expect(node.value.children).toHaveLength(2);
        expect(node.value.children[0].tag).toBe("Text");
        expect(node.value.children[1].tag).toBe("Text");
    });

    it("subscribes to actions via subscribeActions on mount", async () => {
        const onRender = vi.fn(() => {});
        const { subscribeActions } = makeActionBus();

        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(<Spacer />);
        });

        expect(subscribeActions).toHaveBeenCalledTimes(1);
        expect(typeof subscribeActions.mock.calls[0]![0]).toBe("function");
    });

    it("unmount causes onRender to be called with Nil (empty tree)", async () => {
        const onRender = vi.fn((_node: unknown) => {});
        const { subscribeActions } = makeActionBus();

        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(<Text>bye</Text>);
        });

        await act(async () => {
            renderer.unmount();
        });

        const lastNode = onRender.mock.calls[onRender.mock.calls.length - 1]![0] as any;
        expect(lastNode.tag).toBe("Nil");
    });

    it("unmount unsubscribes from actions", async () => {
        const onRender = vi.fn(() => {});
        let unsubscribed = false;
        const subscribeActions = vi.fn((_cb: ActionCallback) => () => {
            unsubscribed = true;
        });

        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(<Spacer />);
        });

        expect(unsubscribed).toBe(false);

        await act(async () => {
            renderer.unmount();
        });

        expect(unsubscribed).toBe(true);
    });

    it("re-renders when a dispatched action triggers a state update", async () => {
        const onRender = vi.fn((_node: unknown) => {});
        const { subscribeActions, dispatch } = makeActionBus();

        function Counter() {
            const [count, setCount] = useState(0);
            return (
                <Column>
                    <Text>{String(count)}</Text>
                    <Button text="+" onClick={() => setCount((c) => c + 1)} />
                </Column>
            );
        }

        const renderer = createRenderer({ onRender, subscribeActions });
        await act(async () => {
            renderer.mount(<Counter />);
        });

        const firstNode = onRender.mock.calls[onRender.mock.calls.length - 1]![0] as any;
        const btn = (firstNode.value.children as any[]).find((c: any) => c.tag === "Button");
        const clickActionId: string = btn.value.props.clickAction;

        await act(async () => {
            dispatch(clickActionId);
        });

        expect(onRender.mock.calls.length).toBeGreaterThan(1);
        const updatedNode = onRender.mock.calls[onRender.mock.calls.length - 1]![0] as any;
        const txt = (updatedNode.value.children as any[]).find((c: any) => c.tag === "Text");
        expect(txt.value.children[0]).toEqual({
            tag: "String",
            value: { text: "1" },
        });
    });

    it("two independent createRenderer calls have isolated state", async () => {
        const onRenderA = vi.fn((_node: unknown) => {});
        const onRenderB = vi.fn((_node: unknown) => {});
        const busA = makeActionBus();
        const busB = makeActionBus();

        function Counter({ start }: { start: number }) {
            const [count, setCount] = useState(start);
            return (
                <Column>
                    <Text>{String(count)}</Text>
                    <Button text="+" onClick={() => setCount((c) => c + 1)} />
                </Column>
            );
        }

        const rendererA = createRenderer({
            onRender: onRenderA,
            subscribeActions: busA.subscribeActions,
        });
        const rendererB = createRenderer({
            onRender: onRenderB,
            subscribeActions: busB.subscribeActions,
        });
        await act(async () => {
            rendererA.mount(<Counter start={0} />);
            rendererB.mount(<Counter start={10} />);
        });

        // Click the button only on instance A
        const nodeA = onRenderA.mock.calls[onRenderA.mock.calls.length - 1]![0] as any;
        const btnA = (nodeA.value.children as any[]).find((c: any) => c.tag === "Button");
        await act(async () => {
            busA.dispatch(btnA.value.props.clickAction);
        });

        const updatedA = onRenderA.mock.calls[onRenderA.mock.calls.length - 1]![0] as any;
        const updatedB = onRenderB.mock.calls[onRenderB.mock.calls.length - 1]![0] as any;
        const txtA = (updatedA.value.children as any[]).find((c: any) => c.tag === "Text");
        const txtB = (updatedB.value.children as any[]).find((c: any) => c.tag === "Text");

        expect(txtA.value.children[0]).toEqual({
            tag: "String",
            value: { text: "1" },
        });
        expect(txtB.value.children[0]).toEqual({
            tag: "String",
            value: { text: "10" },
        });
    });
});
