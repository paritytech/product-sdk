// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { CustomRendererNode } from "@parity/truapi";

import type { Background, BorderStyle, Dimensions, Modifier, Padding, Size } from "./types.js";

export type WidgetInstance = {
    type: string;
    props: Record<string, unknown>;
    children: (WidgetInstance | TextInstance)[];
};

export type TextInstance = {
    __isText: true;
    text: string;
};

function isTextInstance(node: WidgetInstance | TextInstance): node is TextInstance {
    return "__isText" in node;
}

function convertDimensions(value: Padding): Dimensions {
    if (typeof value === "number" || typeof value === "bigint") {
        return { top: value, end: value };
    }
    return value;
}

function convertModifiers(props: Record<string, unknown>): Modifier[] {
    const modifiers: Modifier[] = [];

    if (props.margin !== undefined) {
        modifiers.push({
            tag: "Margin",
            value: convertDimensions(props.margin as Padding),
        });
    }
    if (props.padding !== undefined) {
        modifiers.push({
            tag: "Padding",
            value: convertDimensions(props.padding as Padding),
        });
    }
    if (props.background !== undefined) {
        const bg = props.background as Background;
        modifiers.push({
            tag: "Background",
            value: typeof bg === "string" ? { color: bg } : { color: bg.color, shape: bg.shape },
        });
    }
    if (props.border !== undefined) {
        modifiers.push({ tag: "Border", value: props.border as BorderStyle });
    }
    if (props.width !== undefined) {
        modifiers.push({ tag: "Width", value: { width: props.width as Size } });
    }
    if (props.height !== undefined) {
        modifiers.push({ tag: "Height", value: { height: props.height as Size } });
    }
    if (props.minWidth !== undefined) {
        modifiers.push({
            tag: "MinWidth",
            value: { width: props.minWidth as Size },
        });
    }
    if (props.minHeight !== undefined) {
        modifiers.push({
            tag: "MinHeight",
            value: { height: props.minHeight as Size },
        });
    }
    if (props.fillMaxWidth) {
        modifiers.push({ tag: "FillWidth", value: { enabled: true } });
    }
    if (props.fillMaxHeight) {
        modifiers.push({ tag: "FillHeight", value: { enabled: true } });
    }

    return modifiers;
}

function convertWidgetProps(widgetType: string, props: Record<string, unknown>): unknown {
    switch (widgetType) {
        case "Box":
            return { contentAlignment: props.contentAlignment as string | undefined };
        case "Column":
            return {
                horizontalAlignment: props.horizontalAlignment as string | undefined,
                verticalArrangement: props.verticalArrangement as string | undefined,
            };
        case "Row":
            return {
                verticalAlignment: props.verticalAlignment as string | undefined,
                horizontalArrangement: props.horizontalArrangement as string | undefined,
            };
        case "Spacer":
            return undefined;
        case "Text":
            return {
                style: props.style as string | undefined,
                color: props.color as string | undefined,
            };
        case "Button":
            return {
                text: (props.text as string | undefined) ?? "",
                variant: props.variant as string | undefined,
                enabled: props.enabled as boolean | undefined,
                loading: props.loading as boolean | undefined,
                clickAction: props.clickAction,
            };
        case "TextField":
            return {
                text: (props.value as string | undefined) ?? "",
                placeholder: props.placeholder as string | undefined,
                label: props.label as string | undefined,
                enabled: props.enabled as boolean | undefined,
                valueChangeAction: props.valueChangeAction,
            };
        default:
            return undefined;
    }
}

function serializeNode(node: WidgetInstance | TextInstance): CustomRendererNode {
    if (isTextInstance(node)) {
        return { tag: "String", value: { text: node.text } };
    }

    return {
        tag: node.type,
        value: {
            modifiers: convertModifiers(node.props),
            props: convertWidgetProps(node.type, node.props),
            children: node.children.map((child) => serializeNode(child)),
        },
    } as CustomRendererNode;
}

/**
 * Serialize the reconciler tree into a single root node: Nil when empty, the
 * sole child when there is one, otherwise the children wrapped in a Column.
 */
export function serializeAndRender(
    children: (WidgetInstance | TextInstance)[],
): CustomRendererNode {
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
