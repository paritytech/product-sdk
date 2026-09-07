// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Translate a truapi-shaped `CustomRendererNode` (what
 * `@parity/product-sdk-react-renderer` emits) into the novasama-shaped node the
 * legacy native chat backend's codec expects.
 *
 * The structural transforms invert the renderer's serializer:
 *  - modifier tags: `Margin` → `margin`;
 *  - `Width`/`Height`/`MinWidth`/`MinHeight` values: `{ width }` / `{ height }` → bare `Size`;
 *  - `FillWidth`/`FillHeight` values: `{ enabled }` → bare `boolean`;
 *  - `Dimensions`: struct `{ top, end, bottom?, start? }` → tuple `[top, end, bottom?, start?]`;
 *  - `String` node: `{ text }` → bare string;
 *  - `Shape` `Rounded`: `{ radius }` → bare `Size`.
 *
 * Enum values additionally need casing translation (`FgPrimary` → `fg.primary`),
 * which the serializer does not do — truapi carries PascalCase tokens, novasama
 * dotted/camel ones. The tables below are that vocabulary; there is no shared
 * source (novasama is only loaded via a dynamic import, and truapi's codecs are
 * index-based SCALE enums that don't expose their member strings). `map()`
 * throws on any defined value missing from its table, so a future truapi enum
 * addition fails loudly instead of shipping an un-encodable value.
 *
 * @module
 */

type Any = any;

const COLOR: Record<string, string> = {
    FgPrimary: "fg.primary",
    FgSecondary: "fg.secondary",
    FgTertiary: "fg.tertiary",
    BgSurfaceMain: "bg.surface.main",
    BgSurfaceContainer: "bg.surface.container",
    BgSurfaceNested: "bg.surface.nested",
    FgSuccess: "fg.success",
    FgError: "fg.error",
    FgWarning: "fg.warning",
};
const TYPOGRAPHY: Record<string, string> = {
    HeadlineLarge: "headline.large",
    TitleMediumRegular: "title.medium.regular",
    BodyLargeRegular: "body.large.regular",
    BodyMediumRegular: "body.medium.regular",
    BodySmallRegular: "body.small.regular",
};
const BUTTON_VARIANT: Record<string, string> = {
    Primary: "primary",
    Secondary: "secondary",
    Text: "text",
};
const CONTENT_ALIGNMENT: Record<string, string> = {
    TopStart: "topStart",
    TopCenter: "topCenter",
    TopEnd: "topEnd",
    CenterStart: "centerStart",
    Center: "center",
    CenterEnd: "centerEnd",
    BottomStart: "bottomStart",
    BottomCenter: "bottomCenter",
    BottomEnd: "bottomEnd",
};
const H_ALIGN: Record<string, string> = { Start: "start", Center: "center", End: "end" };
const V_ALIGN: Record<string, string> = { Top: "top", Center: "center", Bottom: "bottom" };
const ARRANGEMENT: Record<string, string> = {
    Start: "start",
    End: "end",
    Center: "center",
    SpaceBetween: "spaceBetween",
    SpaceAround: "spaceAround",
    SpaceEvenly: "spaceEvenly",
};
const MODIFIER_TAG: Record<string, string> = {
    Margin: "margin",
    Padding: "padding",
    Background: "background",
    Border: "border",
    Width: "width",
    Height: "height",
    MinWidth: "minWidth",
    MinHeight: "minHeight",
    FillWidth: "fillWidth",
    FillHeight: "fillHeight",
};

/**
 * Map a truapi enum value to its novasama equivalent. An absent optional prop
 * (`undefined`) passes through; a defined string missing from the table is a
 * real gap (e.g. truapi added an enum variant) and throws loudly rather than
 * shipping an un-encodable value to the novasama codec.
 */
const map = (table: Record<string, string>, value: unknown): unknown => {
    if (value === undefined) return value;
    if (typeof value === "string" && value in table) return table[value];
    throw new Error(`nativeChatNode: unmapped enum value ${JSON.stringify(value)}`);
};

/** Struct `Dimensions` → tuple `[top, end, bottom?, start?]`. */
function toNovaDimensions(d: Any): Any {
    return [d.top, d.end, d.bottom, d.start];
}

/** truapi `Shape` → novasama `Shape` (`Rounded` value `{ radius }` → bare). */
function toNovaShape(shape: Any): Any {
    if (!shape) return shape;
    return shape.tag === "Rounded" ? { tag: "Rounded", value: shape.value.radius } : shape;
}

function toNovaBackground(bg: Any): Any {
    // The serializer always wraps `background` as `{ color, shape? }`.
    return { color: map(COLOR, bg.color), shape: toNovaShape(bg.shape) };
}

function toNovaModifier(mod: Any): Any {
    const tag = MODIFIER_TAG[mod.tag];
    switch (mod.tag) {
        case "Margin":
        case "Padding":
            return { tag, value: toNovaDimensions(mod.value) };
        case "Width":
        case "MinWidth":
            return { tag, value: mod.value.width };
        case "Height":
        case "MinHeight":
            return { tag, value: mod.value.height };
        case "FillWidth":
        case "FillHeight":
            return { tag, value: mod.value.enabled };
        case "Background":
            return { tag, value: toNovaBackground(mod.value) };
        case "Border":
            return {
                tag,
                value: {
                    width: mod.value.width,
                    color: map(COLOR, mod.value.color),
                    shape: toNovaShape(mod.value.shape),
                },
            };
        default:
            // truapi's `Modifier` union is closed; an unknown tag means the
            // union grew and this translator wasn't updated — fail loudly.
            throw new Error(`nativeChatNode: unmapped modifier tag ${JSON.stringify(mod.tag)}`);
    }
}

function toNovaProps(nodeTag: string, props: Any): Any {
    if (!props) return props;
    switch (nodeTag) {
        case "Box":
            return { contentAlignment: map(CONTENT_ALIGNMENT, props.contentAlignment) };
        case "Column":
            return {
                horizontalAlignment: map(H_ALIGN, props.horizontalAlignment),
                verticalArrangement: map(ARRANGEMENT, props.verticalArrangement),
            };
        case "Row":
            return {
                verticalAlignment: map(V_ALIGN, props.verticalAlignment),
                horizontalArrangement: map(ARRANGEMENT, props.horizontalArrangement),
            };
        case "Text":
            return { style: map(TYPOGRAPHY, props.style), color: map(COLOR, props.color) };
        case "Button":
            return { ...props, variant: map(BUTTON_VARIANT, props.variant) };
        // Spacer (undefined props, caught above) and TextField (no enum tokens)
        // carry over unchanged.
        default:
            return props;
    }
}

/** Translate a truapi `CustomRendererNode` into the novasama node shape. */
export function toNovasamaNode(node: Any): Any {
    if (node.tag === "String") {
        return { tag: "String", value: node.value.text };
    }
    if (node.tag === "Nil") {
        return node;
    }
    const component = node.value;
    return {
        tag: node.tag,
        value: {
            modifiers: (component.modifiers ?? []).map(toNovaModifier),
            props: toNovaProps(node.tag, component.props),
            children: (component.children ?? []).map(toNovasamaNode),
        },
    };
}

if (import.meta.vitest) {
    const { describe, it, expect } = import.meta.vitest;

    describe("toNovasamaNode", () => {
        it("unwraps String nodes to a bare string", () => {
            expect(toNovasamaNode({ tag: "String", value: { text: "hi" } })).toEqual({
                tag: "String",
                value: "hi",
            });
        });

        it("passes Nil through", () => {
            expect(toNovasamaNode({ tag: "Nil", value: undefined })).toEqual({
                tag: "Nil",
                value: undefined,
            });
        });

        it("maps Button variant and keeps other props", () => {
            const out = toNovasamaNode({
                tag: "Button",
                value: {
                    modifiers: [],
                    props: {
                        text: "Go",
                        variant: "Primary",
                        enabled: true,
                        loading: false,
                        clickAction: "a1",
                    },
                    children: [],
                },
            });
            expect(out.value.props).toEqual({
                text: "Go",
                variant: "primary",
                enabled: true,
                loading: false,
                clickAction: "a1",
            });
        });

        it("maps Column/Row alignment + arrangement enums", () => {
            const col = toNovasamaNode({
                tag: "Column",
                value: {
                    modifiers: [],
                    props: { horizontalAlignment: "Center", verticalArrangement: "SpaceBetween" },
                    children: [],
                },
            });
            expect(col.value.props).toEqual({
                horizontalAlignment: "center",
                verticalArrangement: "spaceBetween",
            });

            const row = toNovasamaNode({
                tag: "Row",
                value: {
                    modifiers: [],
                    props: { verticalAlignment: "Bottom", horizontalArrangement: "SpaceEvenly" },
                    children: [],
                },
            });
            expect(row.value.props).toEqual({
                verticalAlignment: "bottom",
                horizontalArrangement: "spaceEvenly",
            });
        });

        it("converts modifier tags, struct Dimensions → tuple, and unwrapped values", () => {
            const mods = [
                { tag: "Padding", value: { top: 8, end: 8 } },
                { tag: "Margin", value: { top: 1, end: 2, bottom: 3, start: 4 } },
                { tag: "Width", value: { width: 100 } },
                { tag: "MinHeight", value: { height: 20 } },
                { tag: "FillWidth", value: { enabled: true } },
            ];
            const out = toNovasamaNode({
                tag: "Spacer",
                value: { modifiers: mods, props: undefined, children: [] },
            });
            expect(out.value.modifiers).toEqual([
                { tag: "padding", value: [8, 8, undefined, undefined] },
                { tag: "margin", value: [1, 2, 3, 4] },
                { tag: "width", value: 100 },
                { tag: "minHeight", value: 20 },
                { tag: "fillWidth", value: true },
            ]);
        });

        it("translates Background + Border colors and Shape.Rounded radius", () => {
            const out = toNovasamaNode({
                tag: "Box",
                value: {
                    modifiers: [
                        {
                            tag: "Background",
                            value: {
                                color: "BgSurfaceContainer",
                                shape: { tag: "Rounded", value: { radius: 10 } },
                            },
                        },
                        {
                            tag: "Border",
                            value: {
                                width: 1,
                                color: "FgTertiary",
                                shape: { tag: "Circle", value: undefined },
                            },
                        },
                    ],
                    props: { contentAlignment: "Center" },
                    children: [],
                },
            });
            expect(out.value.modifiers).toEqual([
                {
                    tag: "background",
                    value: { color: "bg.surface.container", shape: { tag: "Rounded", value: 10 } },
                },
                {
                    tag: "border",
                    value: {
                        width: 1,
                        color: "fg.tertiary",
                        shape: { tag: "Circle", value: undefined },
                    },
                },
            ]);
        });

        it("recurses into children (full coin-flip-style tree)", () => {
            const tree = {
                tag: "Column",
                value: {
                    modifiers: [{ tag: "Padding", value: { top: 10, end: 10 } }],
                    props: { horizontalAlignment: "Center", verticalArrangement: "Center" },
                    children: [
                        {
                            tag: "Text",
                            value: {
                                modifiers: [],
                                props: { style: "BodySmallRegular", color: "FgPrimary" },
                                children: [{ tag: "String", value: { text: "Flip #1" } }],
                            },
                        },
                        {
                            tag: "Text",
                            value: {
                                modifiers: [],
                                props: { style: "HeadlineLarge" },
                                children: [{ tag: "String", value: { text: "HEADS" } }],
                            },
                        },
                    ],
                },
            };
            const out = toNovasamaNode(tree) as Any;
            expect(out.value.modifiers[0]).toEqual({
                tag: "padding",
                value: [10, 10, undefined, undefined],
            });
            expect(out.value.props.horizontalAlignment).toBe("center");
            expect(out.value.children[0].value.props).toEqual({
                style: "body.small.regular",
                color: "fg.primary",
            });
            expect(out.value.children[0].value.children[0]).toEqual({
                tag: "String",
                value: "Flip #1",
            });
            expect(out.value.children[1].value.children[0]).toEqual({
                tag: "String",
                value: "HEADS",
            });
        });

        // Exhaustive per-enum coverage: every truapi value maps to the exact
        // novasama string its codec accepts. Guards against a drifted table.
        const cases: Array<
            [string, Record<string, string>, (v: string) => Any, (out: Any) => unknown]
        > = [
            [
                "ColorToken",
                COLOR,
                (v) => ({
                    tag: "Text",
                    value: { modifiers: [], props: { color: v }, children: [] },
                }),
                (o) => o.value.props.color,
            ],
            [
                "TypographyStyle",
                TYPOGRAPHY,
                (v) => ({
                    tag: "Text",
                    value: { modifiers: [], props: { style: v }, children: [] },
                }),
                (o) => o.value.props.style,
            ],
            [
                "ButtonVariant",
                BUTTON_VARIANT,
                (v) => ({
                    tag: "Button",
                    value: { modifiers: [], props: { text: "x", variant: v }, children: [] },
                }),
                (o) => o.value.props.variant,
            ],
            [
                "Arrangement",
                ARRANGEMENT,
                (v) => ({
                    tag: "Column",
                    value: { modifiers: [], props: { verticalArrangement: v }, children: [] },
                }),
                (o) => o.value.props.verticalArrangement,
            ],
            [
                "ContentAlignment",
                CONTENT_ALIGNMENT,
                (v) => ({
                    tag: "Box",
                    value: { modifiers: [], props: { contentAlignment: v }, children: [] },
                }),
                (o) => o.value.props.contentAlignment,
            ],
        ];

        for (const [name, table, build, read] of cases) {
            it(`${name}: every value maps to its novasama equivalent`, () => {
                for (const [truapi, nova] of Object.entries(table)) {
                    expect(read(toNovasamaNode(build(truapi)))).toBe(nova);
                }
            });
        }

        it("throws on an unmapped enum value (e.g. a new truapi variant)", () => {
            expect(() =>
                toNovasamaNode({
                    tag: "Text",
                    value: { modifiers: [], props: { color: "FgNeon" }, children: [] },
                }),
            ).toThrow(/unmapped enum value/);
        });
    });
}
