// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type {
    Arrangement,
    Background as BackgroundStyle,
    BorderStyle,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    Dimensions,
    HorizontalAlignment,
    Shape,
    Size,
    TypographyStyle,
    VerticalAlignment,
} from "@parity/truapi";

export type {
    Arrangement,
    BackgroundStyle,
    BorderStyle,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    Dimensions,
    HorizontalAlignment,
    Shape,
    Size,
    TypographyStyle,
    VerticalAlignment,
};
export type { Modifier } from "@parity/truapi";

/** Uniform (single number) or per-side spacing. */
export type Padding = Size | Dimensions;

/** Plain color token or full background style. */
export type Background = ColorToken | BackgroundStyle;

export interface BaseWidgetProps {
    margin?: Padding;
    padding?: Padding;
    background?: Background;
    border?: BorderStyle;
    width?: Size;
    height?: Size;
    minWidth?: Size;
    minHeight?: Size;
    fillMaxWidth?: boolean;
    fillMaxHeight?: boolean;
}

export interface BoxProps extends BaseWidgetProps {
    contentAlignment?: ContentAlignment;
}

export interface ColumnProps extends BaseWidgetProps {
    horizontalAlignment?: HorizontalAlignment;
    verticalArrangement?: Arrangement;
}

export interface RowProps extends BaseWidgetProps {
    verticalAlignment?: VerticalAlignment;
    horizontalArrangement?: Arrangement;
}

export type SpacerProps = BaseWidgetProps;

export interface TextProps extends BaseWidgetProps {
    style?: TypographyStyle;
    color?: ColorToken;
}

export interface ButtonProps extends BaseWidgetProps {
    text: string;
    variant?: ButtonVariant;
    enabled?: boolean;
    loading?: boolean;
    onClick(): void;
}

export interface TextFieldProps extends BaseWidgetProps {
    value: string;
    placeholder?: string;
    label?: string;
    enabled?: boolean;
    onValueChange(value: string): void;
}
