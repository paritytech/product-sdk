// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The renderer vocabulary, as data the validator reads and the compiler checks.
 *
 * Every table is pinned to the matching union in `@parity/truapi` through
 * {@link closedSet}, so a vocabulary that grows in a later protocol version
 * fails `pnpm typecheck` here. Without that pin the validator would quietly
 * reject a node the protocol had just gained.
 *
 * @module
 */
import type {
    Arrangement,
    BlendingMode,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    Effect,
    HorizontalAlignment,
    ImageFit,
    TypographyStyle,
    VerticalAlignment,
} from "@parity/truapi";

/**
 * Declares a table that must name every member of `Member`.
 *
 * The currying is what makes it work: `Member` is fixed by the first call and
 * the literal tuple inferred by the second, so a table missing a member
 * resolves its parameter type to `never` and fails to compile.
 */
function closedSet<Member extends string>() {
    return <Table extends readonly Member[]>(
        table: Table & ([Exclude<Member, Table[number]>] extends [never] ? unknown : never),
    ): Table => table;
}

export const COLOR_TOKENS = closedSet<ColorToken>()([
    "FgPrimary",
    "FgSecondary",
    "FgTertiary",
    "BgSurfaceMain",
    "BgSurfaceContainer",
    "BgSurfaceNested",
    "FgSuccess",
    "FgError",
    "FgWarning",
] as const);

export const TYPOGRAPHY_STYLES = closedSet<TypographyStyle>()([
    "HeadlineLarge",
    "TitleMediumRegular",
    "BodyLargeRegular",
    "BodyMediumRegular",
    "BodySmallRegular",
] as const);

export const BUTTON_VARIANTS = closedSet<ButtonVariant>()([
    "Primary",
    "Secondary",
    "Text",
] as const);

export const IMAGE_FITS = closedSet<ImageFit>()([
    "None",
    "Fill",
    "Cover",
    "Contain",
    "ScaleDown",
] as const);

export const BLENDING_MODES = closedSet<BlendingMode>()([
    "Normal",
    "Multiply",
    "Screen",
    "Overlay",
    "Darken",
    "Lighten",
    "ColorDodge",
    "ColorBurn",
    "HardLight",
    "SoftLight",
    "Difference",
    "Exclusion",
    "Hue",
    "Saturation",
    "Color",
    "Luminosity",
] as const);

export const ARRANGEMENTS = closedSet<Arrangement>()([
    "Start",
    "End",
    "Center",
    "SpaceBetween",
    "SpaceAround",
    "SpaceEvenly",
] as const);

export const HORIZONTAL_ALIGNMENTS = closedSet<HorizontalAlignment>()([
    "Start",
    "Center",
    "End",
] as const);

export const VERTICAL_ALIGNMENTS = closedSet<VerticalAlignment>()([
    "Top",
    "Center",
    "Bottom",
] as const);

export const CONTENT_ALIGNMENTS = closedSet<ContentAlignment>()([
    "TopStart",
    "TopCenter",
    "TopEnd",
    "CenterStart",
    "Center",
    "CenterEnd",
    "BottomStart",
    "BottomCenter",
    "BottomEnd",
] as const);

export const EFFECTS = closedSet<Effect>()(["Rainbow"] as const);

/** What a single field may hold. */
export type FieldKind =
    | { kind: "string" }
    | { kind: "boolean" }
    | { kind: "size" }
    | { kind: "opacity" }
    | { kind: "dimensions" }
    | { kind: "background" }
    | { kind: "border" }
    | { kind: "imageSource" }
    | { kind: "enum"; members: readonly string[] };

export interface Field {
    type: FieldKind;
    required?: boolean;
}

const str: FieldKind = { kind: "string" };
const flag: FieldKind = { kind: "boolean" };
const size: FieldKind = { kind: "size" };
const enumOf = (members: readonly string[]): FieldKind => ({ kind: "enum", members });

export interface NodeSchema {
    /** `value.modifiers` is part of this node. */
    modifiers?: boolean;
    /** `value.children` is part of this node. */
    children?: boolean;
    /** Fields under `value.props`. */
    props?: Record<string, Field>;
    /** Fields directly under `value`. Only `String` has any. */
    fields?: Record<string, Field>;
}

/** The eleven node types, keyed by their `tag`. */
export const NODE_SCHEMA: Record<string, NodeSchema> = {
    Nil: {},
    String: { fields: { text: { type: str, required: true } } },
    Box: {
        modifiers: true,
        children: true,
        props: { contentAlignment: { type: enumOf(CONTENT_ALIGNMENTS) } },
    },
    Column: {
        modifiers: true,
        children: true,
        props: {
            horizontalAlignment: { type: enumOf(HORIZONTAL_ALIGNMENTS) },
            verticalArrangement: { type: enumOf(ARRANGEMENTS) },
        },
    },
    Row: {
        modifiers: true,
        children: true,
        props: {
            verticalAlignment: { type: enumOf(VERTICAL_ALIGNMENTS) },
            horizontalArrangement: { type: enumOf(ARRANGEMENTS) },
        },
    },
    Spacer: { modifiers: true },
    Text: {
        modifiers: true,
        children: true,
        props: {
            style: { type: enumOf(TYPOGRAPHY_STYLES) },
            color: { type: enumOf(COLOR_TOKENS) },
        },
    },
    Button: {
        modifiers: true,
        children: true,
        props: {
            text: { type: str, required: true },
            variant: { type: enumOf(BUTTON_VARIANTS) },
            enabled: { type: flag },
            loading: { type: flag },
            clickAction: { type: str },
        },
    },
    TextField: {
        modifiers: true,
        props: {
            text: { type: str, required: true },
            placeholder: { type: str },
            label: { type: str },
            enabled: { type: flag },
            valueChangeAction: { type: str },
        },
    },
    Image: {
        modifiers: true,
        props: {
            source: { type: { kind: "imageSource" }, required: true },
            fit: { type: enumOf(IMAGE_FITS) },
        },
    },
    Effect: { children: true, props: { effect: { type: enumOf(EFFECTS), required: true } } },
};

/** The twelve modifiers, keyed by their `tag`, each mapped to what its `value` holds. */
export const MODIFIER_SCHEMA: Record<string, FieldKind> = {
    Margin: { kind: "dimensions" },
    Padding: { kind: "dimensions" },
    Background: { kind: "background" },
    Border: { kind: "border" },
    Height: size,
    Width: size,
    MinWidth: size,
    MinHeight: size,
    FillWidth: flag,
    FillHeight: flag,
    Opacity: { kind: "opacity" },
    BlendingMode: enumOf(BLENDING_MODES),
};

/** The three shapes, keyed by their `tag`, mapped to what `value` holds, or `null` for a unit variant. */
export const SHAPE_SCHEMA: Record<string, FieldKind | null> = {
    Rounded: size,
    Circle: null,
    Square: null,
};

/** The two image sources. Both carry a string. */
export const IMAGE_SOURCE_TAGS = ["Bulletin", "Archive"] as const;
