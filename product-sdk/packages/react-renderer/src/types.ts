// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type {
    Arrangement,
    Background as BackgroundStyle,
    BlendingMode,
    BorderStyle,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    Dimensions,
    HorizontalAlignment,
    ImageFit,
    ImageRef,
    ImageSource,
    MaterialInstance,
    Parameter,
    Shape,
    Size,
    TypographyStyle,
    VerticalAlignment,
} from "@parity/truapi";

export type {
    Arrangement,
    BackgroundStyle,
    BlendingMode,
    BorderStyle,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    Dimensions,
    HorizontalAlignment,
    ImageFit,
    ImageRef,
    ImageSource,
    MaterialInstance,
    Parameter,
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
    /** 0 is fully transparent, 255 fully opaque. */
    opacity?: number;
    blendingMode?: BlendingMode;
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
    /**
     * Run when the button is pressed.
     *
     * Optional, because a face drawn where nothing is listening should name no
     * action at all. Leave it out and no `clickAction` is emitted.
     */
    onClick?(): void;
}

export interface TextFieldProps extends BaseWidgetProps {
    value: string;
    placeholder?: string;
    label?: string;
    enabled?: boolean;
    /** Run on every change. Leave it out and no `valueChangeAction` is emitted. */
    onValueChange?(value: string): void;
}

export interface ImageProps extends BaseWidgetProps {
    source: ImageSource;
    /** Defaults to `Fill`. */
    fit?: ImageFit;
}

/** The one widget the protocol gives no modifiers, hence no {@link BaseWidgetProps}. */
export interface MaterialsProps {
    /**
     * The layers the host runs over the children, in drawing order. Each names a
     * material by the hash of its text and gives one argument per parameter.
     * Numbers are single-precision bit patterns: write `floatBits(0.5)` from
     * `@parity/product-sdk-renderer`, not `0.5`.
     */
    layers: MaterialInstance[];
}
