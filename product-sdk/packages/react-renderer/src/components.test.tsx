// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// @ts-expect-error Untyped
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { str } from "@parity/truapi/scale";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act } from "react";

import { Box, Button, Column, Row, Spacer, Text, TextField } from "./components.js";
import type { ActionCallback } from "./context.js";
import { createRenderer } from "./renderer.js";

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

/**
 * Mounts a single element and returns the serialized root node plus a dispatch helper.
 */
async function mount(element: ReactNode) {
    const bus = makeActionBus();
    const onRender = vi.fn((_node: unknown) => {});
    const renderer = createRenderer({
        onRender,
        subscribeActions: bus.subscribeActions,
    });

    await act(async () => {
        renderer.mount(element);
    });

    function lastNode() {
        return onRender.mock.calls[onRender.mock.calls.length - 1]![0] as any;
    }

    async function dispatchAction(actionId: string, payload?: Uint8Array) {
        await act(async () => {
            bus.dispatch(actionId, payload);
        });
    }

    return { node: lastNode(), lastNode, dispatchAction, onRender, renderer };
}

describe("custom components", () => {
    describe("Box", () => {
        it("serializes contentAlignment prop", async () => {
            const { node } = await mount(<Box contentAlignment="Center" />);
            expect(node.tag).toBe("Box");
            expect(node.value.props.contentAlignment).toBe("Center");
        });

        it("passes children through", async () => {
            const { node } = await mount(
                <Box>
                    <Text>child</Text>
                </Box>,
            );
            expect(node.value.children).toHaveLength(1);
            expect(node.value.children[0].tag).toBe("Text");
        });
    });

    describe("Column", () => {
        it("serializes horizontalAlignment and verticalArrangement props", async () => {
            const { node } = await mount(
                <Column horizontalAlignment="Center" verticalArrangement="SpaceBetween" />,
            );
            expect(node.tag).toBe("Column");
            expect(node.value.props.horizontalAlignment).toBe("Center");
            expect(node.value.props.verticalArrangement).toBe("SpaceBetween");
        });

        it("passes children through", async () => {
            const { node } = await mount(
                <Column>
                    <Spacer />
                    <Spacer />
                </Column>,
            );
            expect(node.value.children).toHaveLength(2);
        });
    });

    describe("Row", () => {
        it("serializes verticalAlignment and horizontalArrangement props", async () => {
            const { node } = await mount(
                <Row verticalAlignment="Center" horizontalArrangement="End" />,
            );
            expect(node.tag).toBe("Row");
            expect(node.value.props.verticalAlignment).toBe("Center");
            expect(node.value.props.horizontalArrangement).toBe("End");
        });
    });

    describe("Spacer", () => {
        it("serializes as a Spacer node with no props", async () => {
            const { node } = await mount(<Spacer />);
            expect(node.tag).toBe("Spacer");
        });

        it("forwards layout modifiers", async () => {
            const { node } = await mount(<Spacer height={16} />);
            const heightMod = (node.value.modifiers as any[]).find((m: any) => m.tag === "Height");
            expect(heightMod.value).toEqual({ height: 16 });
        });
    });

    describe("Text", () => {
        it("serializes style and color props", async () => {
            const { node } = await mount(<Text style="HeadlineLarge" color="FgPrimary" />);
            expect(node.tag).toBe("Text");
            expect(node.value.props.style).toBe("HeadlineLarge");
            expect(node.value.props.color).toBe("FgPrimary");
        });

        it("renders text content as a String child", async () => {
            const { node } = await mount(<Text>Hello world</Text>);
            expect(node.value.children[0]).toEqual({
                tag: "String",
                value: { text: "Hello world" },
            });
        });

        it("forwards layout modifiers", async () => {
            const { node } = await mount(<Text padding={8}>hi</Text>);
            const paddingMod = (node.value.modifiers as any[]).find(
                (m: any) => m.tag === "Padding",
            );
            expect(paddingMod.value).toEqual({ top: 8, end: 8 });
        });
    });

    describe("Button", () => {
        it("serializes text, variant, enabled and loading props", async () => {
            const { node } = await mount(
                <Button
                    text="Submit"
                    variant="Primary"
                    enabled={false}
                    loading={true}
                    onClick={vi.fn(() => {})}
                />,
            );
            expect(node.tag).toBe("Button");
            expect(node.value.props.text).toBe("Submit");
            expect(node.value.props.variant).toBe("Primary");
            expect(node.value.props.enabled).toBe(false);
            expect(node.value.props.loading).toBe(true);
        });

        it("exposes a non-empty clickAction string in serialized props", async () => {
            const { node } = await mount(<Button text="Click me" onClick={vi.fn(() => {})} />);
            expect(typeof node.value.props.clickAction).toBe("string");
            expect((node.value.props.clickAction as string).length).toBeGreaterThan(0);
        });

        it("calls onClick when the clickAction is dispatched without a payload", async () => {
            const onClick = vi.fn(() => {});
            const { node, dispatchAction } = await mount(<Button text="Go" onClick={onClick} />);

            await dispatchAction(node.value.props.clickAction as string);

            expect(onClick).toHaveBeenCalledTimes(1);
        });

        it("calls onClick when the clickAction is dispatched with a payload", async () => {
            const onClick = vi.fn(() => {});
            const { node, dispatchAction } = await mount(<Button text="Go" onClick={onClick} />);

            await dispatchAction(node.value.props.clickAction as string, new Uint8Array([1, 2, 3]));

            expect(onClick).toHaveBeenCalledTimes(1);
        });

        it("calls an updated onClick handler after re-render", async () => {
            const onClick1 = vi.fn(() => {});
            const onClick2 = vi.fn(() => {});

            const bus = makeActionBus();
            const onRender = vi.fn((_node: unknown) => {});
            const renderer = createRenderer({
                onRender,
                subscribeActions: bus.subscribeActions,
            });

            await act(async () => {
                renderer.mount(<Button text="Go" onClick={onClick1} />);
            });

            const actionId: string = (onRender.mock.calls[0]![0] as any).value.props.clickAction;

            // Re-mount with a different onClick handler
            await act(async () => {
                renderer.mount(<Button text="Go" onClick={onClick2} />);
            });

            await act(async () => {
                bus.dispatch(actionId);
            });

            expect(onClick1).not.toHaveBeenCalled();
            expect(onClick2).toHaveBeenCalledTimes(1);
        });
    });

    describe("TextField", () => {
        it("maps value prop to text in serialized props", async () => {
            const { node } = await mount(
                <TextField value="hello" onValueChange={vi.fn(() => {})} />,
            );
            expect(node.tag).toBe("TextField");
            expect(node.value.props.text).toBe("hello");
        });

        it("serializes placeholder, label and enabled props", async () => {
            const { node } = await mount(
                <TextField
                    value=""
                    placeholder="Type here"
                    label="Name"
                    enabled={false}
                    onValueChange={vi.fn(() => {})}
                />,
            );
            expect(node.value.props.placeholder).toBe("Type here");
            expect(node.value.props.label).toBe("Name");
            expect(node.value.props.enabled).toBe(false);
        });

        it("exposes a non-empty valueChangeAction string in serialized props", async () => {
            const { node } = await mount(<TextField value="" onValueChange={vi.fn(() => {})} />);
            expect(typeof node.value.props.valueChangeAction).toBe("string");
            expect((node.value.props.valueChangeAction as string).length).toBeGreaterThan(0);
        });

        it("calls onValueChange with the decoded string when the action fires with a SCALE string payload", async () => {
            const onValueChange = vi.fn(() => {});
            const { node, dispatchAction } = await mount(
                <TextField value="" onValueChange={onValueChange} />,
            );

            const encoded = str.enc("hello world");
            await dispatchAction(node.value.props.valueChangeAction as string, encoded);

            expect(onValueChange).toHaveBeenCalledTimes(1);
            expect(onValueChange).toHaveBeenCalledWith("hello world");
        });

        it("calls onValueChange with empty string when the action fires without a payload", async () => {
            const onValueChange = vi.fn(() => {});
            const { node, dispatchAction } = await mount(
                <TextField value="" onValueChange={onValueChange} />,
            );

            await dispatchAction(node.value.props.valueChangeAction as string);

            expect(onValueChange).toHaveBeenCalledTimes(1);
            expect(onValueChange).toHaveBeenCalledWith("");
        });

        it("calls an updated onValueChange handler after re-render", async () => {
            const handler1 = vi.fn(() => {});
            const handler2 = vi.fn(() => {});

            const bus = makeActionBus();
            const onRender = vi.fn((_node: unknown) => {});
            const renderer = createRenderer({
                onRender,
                subscribeActions: bus.subscribeActions,
            });

            await act(async () => {
                renderer.mount(<TextField value="" onValueChange={handler1} />);
            });

            const actionId: string = (onRender.mock.calls[0]![0] as any).value.props
                .valueChangeAction;

            await act(async () => {
                renderer.mount(<TextField value="" onValueChange={handler2} />);
            });

            const encoded = str.enc("updated");
            await act(async () => {
                bus.dispatch(actionId, encoded);
            });

            expect(handler1).not.toHaveBeenCalled();
            expect(handler2).toHaveBeenCalledWith("updated");
        });
    });
});
