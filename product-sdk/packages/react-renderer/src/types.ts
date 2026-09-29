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
    Effect,
    HorizontalAlignment,
    ImageFit,
    ImageSource,
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
    Effect,
    HorizontalAlignment,
    ImageFit,
    ImageSource,
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
export interface EffectProps {
    effect: Effect;
}
