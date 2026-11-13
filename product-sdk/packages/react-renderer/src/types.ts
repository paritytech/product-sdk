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
    SlideToConfirmVariant,
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
    SlideToConfirmVariant,
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

/**
 * A control the person slides to confirm, for a step that should be deliberate
 * rather than a tap. The host owns the drag and reports only a completed slide,
 * so `onConfirm` runs once, with nothing passed, as a `Button`'s `onClick` does.
 */
export interface SlideToConfirmProps extends BaseWidgetProps {
    /** The label on the track, such as "Slide to register". */
    text: string;
    /** A second line under the label, such as a date. */
    secondaryText?: string;
    /** What the control reads once the slide is done. Absent keeps `text`. */
    confirmedText?: string;
    /** `Thumb` (the default) moves a thumb along a track; `Reveal` peels the face away. */
    variant?: SlideToConfirmVariant;
    /** Tint of the thumb, or of the surface a `Reveal` uncovers. Absent leaves it to the host. */
    accent?: ColorToken;
    enabled?: boolean;
    /** A loading control takes no slide. */
    loading?: boolean;
    /** Draw the control as already slid. A confirmed control takes no slide. */
    confirmed?: boolean;
    /**
     * Run when a slide completes.
     *
     * Optional, because a control drawn where nothing is listening should name
     * no action at all. Leave it out and no `confirmAction` is emitted.
     */
    onConfirm?(): void;
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
