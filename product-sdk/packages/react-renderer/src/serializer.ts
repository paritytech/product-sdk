// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { RendererNode } from "@parity/truapi";

import type {
    Background,
    BackgroundStyle,
    BlendingMode,
    BorderStyle,
    Dimensions,
    Effect,
    ImageFit,
    ImageSource,
    Modifier,
    Size,
} from "./types.js";

export type WidgetInstance = {
    type: string;
    props: Record<string, unknown>;
    children: (WidgetInstance | TextInstance)[];
};

export type TextInstance = {
    __isText: true;
    text: string;
};

/**
 * Every node tag this serializer emits. `Nil` stands for an empty tree and
 * `String` for text content; each of the rest comes from a component and has
 * an entry in {@link WIDGET_SHAPES}.
 *
 * `serializer.test.tsx` holds this list against the protocol's own vocabulary,
 * so a node type the protocol gains cannot quietly stay unreachable from JSX.
 */
export const SERIALIZED_NODES = [
    "Nil",
    "String",
    "Box",
    "Column",
    "Row",
    "Spacer",
    "Text",
    "Button",
    "TextField",
    "Image",
    "Effect",
] as const satisfies readonly RendererNode["tag"][];

/**
 * Every modifier tag this serializer emits, in the order it emits them, held
 * against the protocol by the same test.
 */
export const SERIALIZED_MODIFIERS = [
    "Margin",
    "Padding",
    "Background",
    "Border",
    "Width",
    "Height",
    "MinWidth",
    "MinHeight",
    "FillWidth",
    "FillHeight",
    "Opacity",
    "BlendingMode",
] as const satisfies readonly Modifier["tag"][];

type WidgetTag = Exclude<(typeof SERIALIZED_NODES)[number], "Nil" | "String">;

function isTextInstance(node: WidgetInstance | TextInstance): node is TextInstance {
    return "__isText" in node;
}

function convertDimensions(value: unknown): Dimensions | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number" || typeof value === "bigint") {
        return { top: value, end: value };
    }
    return value as Dimensions;
}

function convertBackground(value: unknown): BackgroundStyle | undefined {
    if (value === undefined) return undefined;
    const fill = value as Background;
    return typeof fill === "string" ? { color: fill } : { color: fill.color, shape: fill.shape };
}

/**
 * How each modifier is read off a widget's props: its protocol value, or
 * `undefined` when the props do not ask for it.
 *
 * Keyed by the modifier tag, so a modifier the protocol gains fails to compile
 * until it has a reader here.
 */
const MODIFIER_READERS: Record<
    Modifier["tag"],
    (props: Record<string, unknown>) => Modifier["value"] | undefined
> = {
    Margin: (props) => convertDimensions(props.margin),
    Padding: (props) => convertDimensions(props.padding),
    Background: (props) => convertBackground(props.background),
    Border: (props) => props.border as BorderStyle | undefined,
    Width: (props) => props.width as Size | undefined,
    Height: (props) => props.height as Size | undefined,
    MinWidth: (props) => props.minWidth as Size | undefined,
    MinHeight: (props) => props.minHeight as Size | undefined,
    // The protocol has no "do not fill", so a false flag is an absent one.
    FillWidth: (props) => (props.fillMaxWidth ? true : undefined),
    FillHeight: (props) => (props.fillMaxHeight ? true : undefined),
    Opacity: (props) => props.opacity as number | undefined,
    BlendingMode: (props) => props.blendingMode as BlendingMode | undefined,
};

function convertModifiers(props: Record<string, unknown>): Modifier[] {
    const modifiers: Modifier[] = [];
    for (const tag of SERIALIZED_MODIFIERS) {
        const value = MODIFIER_READERS[tag](props);
        if (value !== undefined) modifiers.push({ tag, value } as Modifier);
    }
    return modifiers;
}

/**
 * What one widget puts under `value`.
 *
 * The protocol declares each node's fields exactly: `Spacer` carries no
 * `props`, `Spacer`, `TextField` and `Image` carry no `children`, and `Effect`
 * carries no `modifiers`. A host ignores every key a node does not declare, so
 * an extra one draws nothing and shows up only as a validator warning.
 */
type WidgetShape = {
    modifiers: boolean;
    children: boolean;
    props?: (props: Record<string, unknown>) => unknown;
};

const WIDGET_SHAPES: Record<WidgetTag, WidgetShape> = {
    Box: {
        modifiers: true,
        children: true,
        props: (props) => ({ contentAlignment: props.contentAlignment as string | undefined }),
    },
    Column: {
        modifiers: true,
        children: true,
        props: (props) => ({
            horizontalAlignment: props.horizontalAlignment as string | undefined,
            verticalArrangement: props.verticalArrangement as string | undefined,
        }),
    },
    Row: {
        modifiers: true,
        children: true,
        props: (props) => ({
            verticalAlignment: props.verticalAlignment as string | undefined,
            horizontalArrangement: props.horizontalArrangement as string | undefined,
        }),
    },
    Spacer: { modifiers: true, children: false },
    Text: {
        modifiers: true,
        children: true,
        props: (props) => ({
            style: props.style as string | undefined,
            color: props.color as string | undefined,
        }),
    },
    Button: {
        modifiers: true,
        children: true,
        props: (props) => ({
            text: (props.text as string | undefined) ?? "",
            variant: props.variant as string | undefined,
            enabled: props.enabled as boolean | undefined,
            loading: props.loading as boolean | undefined,
            clickAction: props.clickAction,
        }),
    },
    TextField: {
        modifiers: true,
        children: false,
        props: (props) => ({
            text: (props.value as string | undefined) ?? "",
            placeholder: props.placeholder as string | undefined,
            label: props.label as string | undefined,
            enabled: props.enabled as boolean | undefined,
            valueChangeAction: props.valueChangeAction,
        }),
    },
    Image: {
        modifiers: true,
        children: false,
        props: (props) => ({
            source: props.source as ImageSource,
            fit: props.fit as ImageFit | undefined,
        }),
    },
    Effect: {
        modifiers: false,
        children: true,
        props: (props) => ({ effect: props.effect as Effect }),
    },
};

/** An element this renderer has no component for. Emitted as a plain container. */
const UNKNOWN_WIDGET: WidgetShape = { modifiers: true, children: true };

function serializeNode(node: WidgetInstance | TextInstance): RendererNode {
    if (isTextInstance(node)) {
        return { tag: "String", value: { text: node.text } };
    }

    const shape = Object.hasOwn(WIDGET_SHAPES, node.type)
        ? WIDGET_SHAPES[node.type as WidgetTag]
        : UNKNOWN_WIDGET;
    const props = shape.props?.(node.props);

    return {
        tag: node.type,
        value: {
            ...(shape.modifiers ? { modifiers: convertModifiers(node.props) } : {}),
            ...(props === undefined ? {} : { props }),
            ...(shape.children ? { children: node.children.map(serializeNode) } : {}),
        },
    } as RendererNode;
}

/**
 * Serialize the reconciler tree into a single root node: Nil when empty, the
 * sole child when there is one, otherwise the children wrapped in a Column.
 */
export function serializeAndRender(children: (WidgetInstance | TextInstance)[]): RendererNode {
    const serialized = children.map(serializeNode);

    if (serialized.length === 0) {
        return { tag: "Nil", value: undefined };
    }
    if (serialized.length === 1 && serialized[0] !== undefined) {
        return serialized[0];
    }
    return {
        tag: "Column",
        value: {
            modifiers: [],
            props: { horizontalAlignment: undefined, verticalArrangement: undefined },
            children: serialized,
        },
    };
}
