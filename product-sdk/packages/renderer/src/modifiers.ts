// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type {
    BlendingMode,
    ColorToken,
    Dimensions,
    ImageSource,
    Modifier,
    Shape,
    Size,
} from "@parity/truapi";

/**
 * Inner spacing. `padding(16)` is 16 on every edge; `padding(20, 24)` is 20
 * vertical and 24 horizontal.
 *
 * The protocol's `Dimensions` requires `top` and `end` and defaults `bottom` to
 * `top` and `start` to `end`, which is exactly a vertical/horizontal shorthand.
 * Naming it that way is what makes the missing-`end` error unreachable. Reach
 * for {@link paddingEach} when the four edges genuinely differ.
 */
export function padding(vertical: Size, horizontal: Size = vertical): Modifier {
    return { tag: "Padding", value: { top: vertical, end: horizontal } };
}

/** Inner spacing with every edge named. */
export function paddingEach(edges: Dimensions): Modifier {
    return { tag: "Padding", value: edges };
}

/** Outer spacing. Reads as {@link padding} does. */
export function margin(vertical: Size, horizontal: Size = vertical): Modifier {
    return { tag: "Margin", value: { top: vertical, end: horizontal } };
}

/** Outer spacing with every edge named. */
export function marginEach(edges: Dimensions): Modifier {
    return { tag: "Margin", value: edges };
}

/** A background fill. Omitting the shape leaves it to the host. */
export function background(color: ColorToken, shape?: Shape): Modifier {
    return { tag: "Background", value: shape === undefined ? { color } : { color, shape } };
}

/** A border. Omitting the shape leaves it to the host. */
export function border(width: Size, color: ColorToken, shape?: Shape): Modifier {
    return {
        tag: "Border",
        value: shape === undefined ? { width, color } : { width, color, shape },
    };
}

/** A fixed width. */
export function width(value: Size): Modifier {
    return { tag: "Width", value };
}

/** A fixed height. */
export function height(value: Size): Modifier {
    return { tag: "Height", value };
}

/** A minimum width. */
export function minWidth(value: Size): Modifier {
    return { tag: "MinWidth", value };
}

/** A minimum height. */
export function minHeight(value: Size): Modifier {
    return { tag: "MinHeight", value };
}

/** Fill the available width. */
export function fillWidth(value = true): Modifier {
    return { tag: "FillWidth", value };
}

/** Fill the available height. */
export function fillHeight(value = true): Modifier {
    return { tag: "FillHeight", value };
}

/** Opacity, where 0 is transparent and 255 opaque. */
export function opacity(value: number): Modifier {
    return { tag: "Opacity", value };
}

/** How the node composites against what is behind it. */
export function blendingMode(mode: BlendingMode): Modifier {
    return { tag: "BlendingMode", value: mode };
}

/** Rounded corners of the given radius. */
export function rounded(radius: Size): Shape {
    return { tag: "Rounded", value: radius };
}

/** A circle. */
export function circle(): Shape {
    return { tag: "Circle" };
}

/** Square corners. */
export function square(): Shape {
    return { tag: "Square" };
}

/** Image bytes from a Bulletin chain blob, addressed by CID. */
export function bulletin(cid: string): ImageSource {
    return { tag: "Bulletin", value: cid };
}

/** Image bytes from a path inside the product's executable archive. */
export function archive(path: string): ImageSource {
    return { tag: "Archive", value: path };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("padding", () => {
        // `Dimensions` is a shorthand, not a box: `bottom` defaults to `top` and
        // `start` to `end`. Exposing it as vertical/horizontal is what makes the
        // missing-`end` error unreachable, so these tests pin the whole reason
        // this function does not take named edges.
        test("one argument pads every edge", () => {
            expect(padding(16)).toEqual({ tag: "Padding", value: { top: 16, end: 16 } });
        });

        test("two arguments read as vertical then horizontal", () => {
            expect(padding(20, 24)).toEqual({ tag: "Padding", value: { top: 20, end: 24 } });
        });

        test("zero is carried, not treated as absent", () => {
            expect(padding(0, 8)).toEqual({ tag: "Padding", value: { top: 0, end: 8 } });
        });
    });

    describe("paddingEach", () => {
        test("carries all four edges when they differ", () => {
            expect(paddingEach({ top: 1, end: 2, bottom: 3, start: 4 })).toEqual({
                tag: "Padding",
                value: { top: 1, end: 2, bottom: 3, start: 4 },
            });
        });
    });

    describe("margin", () => {
        test("is the same shorthand under a different tag", () => {
            expect(margin(4)).toEqual({ tag: "Margin", value: { top: 4, end: 4 } });
            expect(marginEach({ top: 1, end: 2 })).toEqual({
                tag: "Margin",
                value: { top: 1, end: 2 },
            });
        });
    });

    describe("background", () => {
        test("omits shape when none is given, so the host keeps its default", () => {
            expect(background("BgSurfaceContainer")).toEqual({
                tag: "Background",
                value: { color: "BgSurfaceContainer" },
            });
        });

        test("carries a shape when given", () => {
            expect(background("FgSuccess", rounded(20))).toEqual({
                tag: "Background",
                value: { color: "FgSuccess", shape: { tag: "Rounded", value: 20 } },
            });
        });
    });

    describe("border", () => {
        test("carries width, colour and an optional shape", () => {
            expect(border(2, "FgError", circle())).toEqual({
                tag: "Border",
                value: { width: 2, color: "FgError", shape: { tag: "Circle" } },
            });
        });
    });

    describe("size modifiers", () => {
        test("each tags its own value", () => {
            expect(width(10)).toEqual({ tag: "Width", value: 10 });
            expect(height(11)).toEqual({ tag: "Height", value: 11 });
            expect(minWidth(12)).toEqual({ tag: "MinWidth", value: 12 });
            expect(minHeight(13)).toEqual({ tag: "MinHeight", value: 13 });
        });
    });

    describe("fill modifiers", () => {
        // Defaulting to true is the whole reason these exist: `fillWidth()` reads
        // as the intent, where `{ tag: "FillWidth", value: true }` reads as noise.
        test("default to true", () => {
            expect(fillWidth()).toEqual({ tag: "FillWidth", value: true });
            expect(fillHeight()).toEqual({ tag: "FillHeight", value: true });
        });

        test("accept an explicit false", () => {
            expect(fillWidth(false)).toEqual({ tag: "FillWidth", value: false });
        });
    });

    describe("opacity and blending", () => {
        test("carry their values", () => {
            expect(opacity(128)).toEqual({ tag: "Opacity", value: 128 });
            expect(blendingMode("Multiply")).toEqual({ tag: "BlendingMode", value: "Multiply" });
        });
    });

    describe("shapes", () => {
        test("unit shapes carry no value", () => {
            expect(circle()).toEqual({ tag: "Circle" });
            expect(square()).toEqual({ tag: "Square" });
        });
    });

    describe("image sources", () => {
        // The tree never carries a URL: the host fetches from Bulletin by CID or
        // from a path inside the product's own archive, and nowhere else.
        test("name a Bulletin CID or an archive path", () => {
            expect(bulletin("bafy...")).toEqual({ tag: "Bulletin", value: "bafy..." });
            expect(archive("pocket/logo.png")).toEqual({
                tag: "Archive",
                value: "pocket/logo.png",
            });
        });
    });
}
