// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type {
    Arrangement,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    Effect,
    HorizontalAlignment,
    ImageFit,
    ImageSource,
    Modifier,
    RendererNode,
    Size,
    TypographyStyle,
    VerticalAlignment,
} from "@parity/truapi";

/** Options every node with modifiers accepts. */
export interface NodeOptions {
    modifiers?: Modifier[];
}

export interface TextOptions extends NodeOptions {
    style?: TypographyStyle;
    color?: ColorToken;
}

export interface ColumnOptions extends NodeOptions {
    horizontalAlignment?: HorizontalAlignment;
    verticalArrangement?: Arrangement;
}

export interface RowOptions extends NodeOptions {
    verticalAlignment?: VerticalAlignment;
    horizontalArrangement?: Arrangement;
}

export interface BoxOptions extends NodeOptions {
    contentAlignment?: ContentAlignment;
}

export interface SpacerOptions {
    width?: Size;
    height?: Size;
}

export interface ButtonOptions extends NodeOptions {
    variant?: ButtonVariant;
    enabled?: boolean;
    loading?: boolean;
    /** The id the host reports when the button is pressed. A button without one is inert. */
    clickAction?: string;
}

export interface TextFieldOptions extends NodeOptions {
    text: string;
    placeholder?: string;
    label?: string;
    enabled?: boolean;
    /** The id the host reports on every change, carrying the new value. */
    valueChangeAction?: string;
}

export interface ImageOptions extends NodeOptions {
    fit?: ImageFit;
}

/**
 * Drops keys whose value is `undefined`.
 *
 * An explicit `undefined` and an absent key are the same thing to the protocol
 * but not to `JSON.stringify`, and a face is compared and measured as JSON.
 */
function defined<T extends object>(props: T): T {
    return Object.fromEntries(
        Object.entries(props).filter(([, value]) => value !== undefined),
    ) as T;
}

/** Nothing. Draws no space. */
export function nil(): RendererNode {
    return { tag: "Nil" };
}

/** A raw string node. {@link text} is what you usually want. */
export function str(content: string): RendererNode {
    return { tag: "String", value: { text: content } };
}

/** A line of text, wrapped in the `String` child the protocol requires. */
export function text(content: string, options: TextOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Text", value: { modifiers, props: defined(props), children: [str(content)] } };
}

/** Children stacked vertically. */
export function column(children: RendererNode[], options: ColumnOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Column", value: { modifiers, props: defined(props), children } };
}

/** Children laid out horizontally. */
export function row(children: RendererNode[], options: RowOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Row", value: { modifiers, props: defined(props), children } };
}

/** Children stacked on top of one another. With no children and a background, a filled rectangle. */
export function box(children: RendererNode[], options: BoxOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Box", value: { modifiers, props: defined(props), children } };
}

/** Empty space of a fixed size. */
export function spacer(options: SpacerOptions): RendererNode {
    const modifiers: Modifier[] = [];
    if (options.width !== undefined) modifiers.push({ tag: "Width", value: options.width });
    if (options.height !== undefined) modifiers.push({ tag: "Height", value: options.height });
    return { tag: "Spacer", value: { modifiers } };
}

/** A pressable button. Give it a `clickAction` or it reports nothing. */
export function button(label: string, options: ButtonOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return {
        tag: "Button",
        value: { modifiers, props: defined({ text: label, ...props }), children: [] },
    };
}

/** An editable field. Give it a `valueChangeAction` or it reports nothing. */
export function textField(options: TextFieldOptions): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "TextField", value: { modifiers, props: defined(props) } };
}

/** An image the host fetches. Build the source with `bulletin()` or `archive()`. */
export function image(source: ImageSource, options: ImageOptions = {}): RendererNode {
    const { modifiers = [], ...props } = options;
    return { tag: "Image", value: { modifiers, props: defined({ source, ...props }) } };
}

/** Applies an effect to its children. The only node with no modifiers of its own. */
export function effect(applied: Effect, children: RendererNode[]): RendererNode {
    return { tag: "Effect", value: { props: { effect: applied }, children } };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("text", () => {
        // Wrapping content in a `String` child is the single most repeated piece
        // of boilerplate in every face written by hand so far. A `Text` whose
        // content sits in `props` instead draws empty, with nothing saying why.
        test("wraps its content in the String child the protocol requires", () => {
            expect(text("Loyalty", { style: "TitleMediumRegular", color: "FgPrimary" })).toEqual({
                tag: "Text",
                value: {
                    modifiers: [],
                    props: { style: "TitleMediumRegular", color: "FgPrimary" },
                    children: [{ tag: "String", value: { text: "Loyalty" } }],
                },
            });
        });

        test("omits props the caller did not set rather than sending undefined", () => {
            expect(text("bare")).toEqual({
                tag: "Text",
                value: {
                    modifiers: [],
                    props: {},
                    children: [{ tag: "String", value: { text: "bare" } }],
                },
            });
        });
    });

    describe("column and row", () => {
        test("carry children, modifiers and their own props", () => {
            const child = text("hi");
            expect(column([child], { verticalArrangement: "SpaceBetween" })).toEqual({
                tag: "Column",
                value: {
                    modifiers: [],
                    props: { verticalArrangement: "SpaceBetween" },
                    children: [child],
                },
            });
            expect(row([child], { verticalAlignment: "Center" })).toEqual({
                tag: "Row",
                value: { modifiers: [], props: { verticalAlignment: "Center" }, children: [child] },
            });
        });

        test("take modifiers through the shared option", () => {
            const fill: Modifier = { tag: "FillWidth", value: true };
            expect(column([], { modifiers: [fill] }).value).toMatchObject({ modifiers: [fill] });
        });
    });

    describe("box", () => {
        // A `Box` with no children and a background is how a face draws a plain
        // filled rectangle, which is what the first real card's progress marks
        // are. An empty `children` here is correct, not a mistake.
        test("accepts no children", () => {
            expect(box([], { contentAlignment: "Center" })).toEqual({
                tag: "Box",
                value: { modifiers: [], props: { contentAlignment: "Center" }, children: [] },
            });
        });
    });

    describe("spacer", () => {
        test("turns its width and height into modifiers", () => {
            expect(spacer({ width: 12 })).toEqual({
                tag: "Spacer",
                value: { modifiers: [{ tag: "Width", value: 12 }] },
            });
            expect(spacer({ width: 4, height: 8 })).toEqual({
                tag: "Spacer",
                value: {
                    modifiers: [
                        { tag: "Width", value: 4 },
                        { tag: "Height", value: 8 },
                    ],
                },
            });
        });
    });

    describe("button", () => {
        test("takes its label positionally and its action by name", () => {
            expect(button("Ping", { clickAction: "ping", variant: "Secondary" })).toEqual({
                tag: "Button",
                value: {
                    modifiers: [],
                    props: { text: "Ping", clickAction: "ping", variant: "Secondary" },
                    children: [],
                },
            });
        });
    });

    describe("textField", () => {
        test("carries its current value and change action", () => {
            expect(textField({ text: "", placeholder: "Name", valueChangeAction: "name" })).toEqual(
                {
                    tag: "TextField",
                    value: {
                        modifiers: [],
                        props: { text: "", placeholder: "Name", valueChangeAction: "name" },
                    },
                },
            );
        });
    });

    describe("image", () => {
        test("carries a source and an optional fit", () => {
            const source: ImageSource = { tag: "Archive", value: "pocket/logo.png" };
            expect(image(source, { fit: "Contain" })).toEqual({
                tag: "Image",
                value: { modifiers: [], props: { source, fit: "Contain" } },
            });
        });
    });

    describe("nil, str and effect", () => {
        test("nil carries no value", () => {
            expect(nil()).toEqual({ tag: "Nil" });
        });

        test("str is the raw String node", () => {
            expect(str("raw")).toEqual({ tag: "String", value: { text: "raw" } });
        });

        // `Effect` is the one node with no modifiers of its own.
        test("effect wraps children and carries no modifiers", () => {
            const child = nil();
            const rainbow: Effect = "Rainbow";
            expect(effect(rainbow, [child])).toEqual({
                tag: "Effect",
                value: { props: { effect: "Rainbow" }, children: [child] },
            });
        });
    });
}
