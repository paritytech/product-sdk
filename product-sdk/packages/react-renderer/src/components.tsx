// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { str } from "@parity/truapi/scale";
import type { PropsWithChildren } from "react";
import { createElement } from "react";

import { useAction } from "./context.js";
import { noop } from "./helpers.js";
import type {
    BoxProps,
    ButtonProps,
    ColumnProps,
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

const textDecoder = (payload: Uint8Array | undefined) => {
    if (payload) {
        return str.dec(payload);
    }
    return "";
};

export function TextField({ onValueChange, ...props }: TextFieldProps) {
    const valueChangeAction = useAction(textDecoder, onValueChange);

    return createElement("TextField", { ...props, valueChangeAction });
}
