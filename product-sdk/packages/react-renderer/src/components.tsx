// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { PropsWithChildren } from "react";
import { createElement } from "react";

import { useAction } from "./context.js";
import { noop } from "./helpers.js";
import type {
    BoxProps,
    ButtonProps,
    ColumnProps,
    ImageProps,
    MaterialsProps,
    RowProps,
    SpacerProps,
    TextFieldProps,
    TextProps,
} from "./types.js";

export function Box({ children, ...props }: PropsWithChildren<BoxProps>) {
    return createElement("Box", props, children);
}

export function Column({ children, ...props }: PropsWithChildren<ColumnProps>) {
    return createElement("Column", props, children);
}

export function Row({ children, ...props }: PropsWithChildren<RowProps>) {
    return createElement("Row", props, children);
}

export function Spacer(props: SpacerProps) {
    return createElement("Spacer", props);
}

export function Text({ children, ...props }: PropsWithChildren<TextProps>) {
    return createElement("Text", props, children);
}

export function Button({ children, onClick, ...props }: PropsWithChildren<ButtonProps>) {
    const clickAction = useAction(noop, onClick);

    return createElement("Button", { ...props, clickAction }, children);
}

// TextField values arrive as bare UTF-8, with no length prefix.
const utf8 = new TextDecoder();

const textDecoder = (payload: Uint8Array | undefined) => (payload ? utf8.decode(payload) : "");

export function TextField({ onValueChange, ...props }: TextFieldProps) {
    const valueChangeAction = useAction(textDecoder, onValueChange);

    return createElement("TextField", { ...props, valueChangeAction });
}

export function Image(props: ImageProps) {
    return createElement("Image", props);
}

/**
 * Runs shader layers over its children. A host that cannot draw them, or a
 * material that fails to load, draws the children plain, so the children are
 * the fallback look.
 */
export function Materials({ children, ...props }: PropsWithChildren<MaterialsProps>) {
    return createElement("Materials", props, children);
}
