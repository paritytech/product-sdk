// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { androidLimits, type HostLimits, KNOWN_HOST_LIMITS } from "./limits.js";
import {
    COLOR_TOKENS,
    type Field,
    type FieldKind,
    IMAGE_SOURCE_TAGS,
    MODIFIER_SCHEMA,
    NODE_SCHEMA,
    SHAPE_SCHEMA,
} from "./schema.js";

/** What is wrong with a face. */
export type FaceIssueCode =
    | "invalid-json"
    | "not-an-object"
    | "missing-tag"
    | "unknown-node"
    | "unknown-modifier"
    | "unknown-shape"
    | "unknown-image-source"
    | "unknown-enum"
    | "missing-field"
    | "wrong-type"
    | "size-not-integer"
    | "size-negative"
    | "size-too-large"
    | "opacity-out-of-range"
    | "unknown-field"
    | "button-without-action"
    | "text-field-without-action"
    | "text-without-content"
    | "host-limit-depth"
    | "host-limit-size"
    | "host-limit-bytes";

/** One thing wrong with a face, and where. */
export interface FaceIssue {
    /** Where in the tree, as `.value.children[2].value.props.style`. Empty for the face itself. */
    path: string;
    code: FaceIssueCode;
    message: string;
}

export interface FaceVerdict {
    /** True when there are no errors. Warnings never make a face invalid. */
    ok: boolean;
    /** What the protocol forbids. No host can draw a face with any of these. */
    errors: FaceIssue[];
    /** What the protocol allows and no product means. */
    warnings: FaceIssue[];
}

export interface ValidateFaceOptions {
    /**
     * Check against one host's own bounds and report a breach as an error.
     * Left out, every known host's bounds are checked and a breach is a warning
     * naming that host.
     */
    host?: HostLimits;
}

/** The largest value the protocol's `Compact<u64>` can carry. */
const MAX_PROTOCOL_SIZE = 18446744073709551615n;

const SIZE: FieldKind = { kind: "size" };

const DIMENSIONS_SHORTHAND =
    "Padding and Margin are a shorthand: 'bottom' defaults to 'top' and 'start' to 'end', " +
    "so 'top' and 'end' must both be present.";

/** Collects issues, and knows whether a host's own bound counts as an error here. */
class Verdict {
    readonly errors: FaceIssue[] = [];
    readonly warnings: FaceIssue[] = [];
    readonly limits: readonly HostLimits[];
    private readonly limitsAreErrors: boolean;

    constructor(host: HostLimits | undefined) {
        this.limits = host === undefined ? KNOWN_HOST_LIMITS : [host];
        this.limitsAreErrors = host !== undefined;
    }

    error(path: string, code: FaceIssueCode, message: string): void {
        this.errors.push({ path, code, message });
    }

    warn(path: string, code: FaceIssueCode, message: string): void {
        this.warnings.push({ path, code, message });
    }

    /** A bound belonging to one host: an error when the caller named it, advice otherwise. */
    hostLimit(path: string, code: FaceIssueCode, message: string): void {
        (this.limitsAreErrors ? this.errors : this.warnings).push({ path, code, message });
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent or null. The protocol's optional fields treat the two alike, and so does every host. */
function absent(value: unknown): boolean {
    return value === undefined || value === null;
}

function leaf(path: string): string {
    return path.slice(path.lastIndexOf(".") + 1);
}

/**
 * Check a face against the renderer protocol.
 *
 * Errors are what the protocol forbids: no host can draw them. Warnings are
 * shapes the protocol allows and a product almost certainly did not mean, such
 * as a misspelled prop name, which every host silently ignores.
 *
 * Pass `options.host` when you are about to ship to one host and want its own
 * bounds enforced rather than merely reported.
 */
export function validateFace(face: unknown, options: ValidateFaceOptions = {}): FaceVerdict {
    const verdict = new Verdict(options.host);
    const parsed = readInput(face, verdict);
    if (parsed !== undefined) validateNode(parsed.tree, "", 1, verdict);
    return { ok: verdict.errors.length === 0, errors: verdict.errors, warnings: verdict.warnings };
}

/** Takes the face either parsed or as JSON text, and measures it either way. */
function readInput(face: unknown, verdict: Verdict): { tree: unknown } | undefined {
    const json = typeof face === "string" ? face : JSON.stringify(face);
    if (json !== undefined) measureBytes(json, verdict);
    if (typeof face !== "string") return { tree: face };
    try {
        return { tree: JSON.parse(face) as unknown };
    } catch (cause) {
        verdict.error("", "invalid-json", `the face is not valid JSON: ${String(cause)}`);
        return undefined;
    }
}

function measureBytes(json: string, verdict: Verdict): void {
    const bytes = new TextEncoder().encode(json).length;
    for (const limit of verdict.limits) {
        if (bytes > limit.maxBytes) {
            verdict.hostLimit(
                "",
                "host-limit-bytes",
                `the face is ${bytes} bytes, past what ${limit.name} accepts (${limit.maxBytes})`,
            );
        }
    }
}

function validateNode(node: unknown, path: string, depth: number, verdict: Verdict): void {
    if (!isRecord(node)) {
        verdict.error(path, "not-an-object", "a renderer node must be a JSON object");
        return;
    }
    if (breachesDepth(depth, path, verdict)) return;

    const tag = node.tag;
    if (typeof tag !== "string") {
        verdict.error(path, "missing-tag", "a renderer node needs a string 'tag'");
        return;
    }
    const schema = NODE_SCHEMA[tag];
    if (schema === undefined) {
        verdict.error(
            path,
            "unknown-node",
            `unknown renderer node '${tag}'. Known nodes: ${Object.keys(NODE_SCHEMA).join(", ")}`,
        );
        return;
    }

    reportUnknownFields(node, ["tag", "value"], path, verdict);

    const valuePath = `${path}.value`;
    const value = readChild(node.value, valuePath, verdict);
    if (value === undefined) return;

    const allowed = [
        ...(schema.modifiers === true ? ["modifiers"] : []),
        ...(schema.children === true ? ["children"] : []),
        ...(schema.props === undefined ? [] : ["props"]),
        ...Object.keys(schema.fields ?? {}),
    ];
    reportUnknownFields(value, allowed, valuePath, verdict);

    if (schema.modifiers === true) {
        validateModifiers(value.modifiers, `${valuePath}.modifiers`, verdict);
    }
    if (schema.fields !== undefined) {
        validateFields(value, schema.fields, valuePath, verdict);
    }

    const props =
        schema.props === undefined
            ? {}
            : (readChild(value.props, `${valuePath}.props`, verdict) ?? {});
    if (schema.props !== undefined) {
        validateFields(props, schema.props, `${valuePath}.props`, verdict);
        reportUnknownFields(props, Object.keys(schema.props), `${valuePath}.props`, verdict);
    }

    if (schema.children === true) {
        validateChildren(value.children, `${valuePath}.children`, depth, verdict);
    }

    advise(tag, value, props, valuePath, verdict);
}

function breachesDepth(depth: number, path: string, verdict: Verdict): boolean {
    let breached = false;
    for (const limit of verdict.limits) {
        if (depth > limit.maxDepth) {
            verdict.hostLimit(
                path,
                "host-limit-depth",
                `nested ${depth} levels deep, past what ${limit.name} draws (${limit.maxDepth})`,
            );
            breached = true;
        }
    }
    return breached;
}

/** Reads a nested object. Absent means empty, which is what an omitted container means. */
function readChild(
    value: unknown,
    path: string,
    verdict: Verdict,
): Record<string, unknown> | undefined {
    if (absent(value)) return {};
    if (!isRecord(value)) {
        verdict.error(path, "wrong-type", "expected a JSON object");
        return undefined;
    }
    return value;
}

function validateChildren(children: unknown, path: string, depth: number, verdict: Verdict): void {
    if (absent(children)) return;
    if (!Array.isArray(children)) {
        verdict.error(path, "wrong-type", "'children' must be an array");
        return;
    }
    children.forEach((child, index) =>
        validateNode(child, `${path}[${index}]`, depth + 1, verdict),
    );
}

function validateModifiers(modifiers: unknown, path: string, verdict: Verdict): void {
    if (absent(modifiers)) return;
    if (!Array.isArray(modifiers)) {
        verdict.error(path, "wrong-type", "'modifiers' must be an array");
        return;
    }
    modifiers.forEach((modifier, index) =>
        validateModifier(modifier, `${path}[${index}]`, verdict),
    );
}

function validateModifier(modifier: unknown, path: string, verdict: Verdict): void {
    if (!isRecord(modifier)) {
        verdict.error(path, "not-an-object", "a modifier must be a JSON object");
        return;
    }
    const tag = modifier.tag;
    if (typeof tag !== "string") {
        verdict.error(path, "missing-tag", "a modifier needs a string 'tag'");
        return;
    }
    const kind = MODIFIER_SCHEMA[tag];
    if (kind === undefined) {
        verdict.error(
            path,
            "unknown-modifier",
            `unknown renderer modifier '${tag}'. Known modifiers: ${Object.keys(MODIFIER_SCHEMA).join(", ")}`,
        );
        return;
    }
    reportUnknownFields(modifier, ["tag", "value"], path, verdict);
    validateValue(modifier.value, kind, `${path}.value`, true, verdict);
}

function validateFields(
    holder: Record<string, unknown>,
    fields: Record<string, Field>,
    path: string,
    verdict: Verdict,
): void {
    for (const [name, field] of Object.entries(fields)) {
        validateValue(
            holder[name],
            field.type,
            `${path}.${name}`,
            field.required === true,
            verdict,
        );
    }
}

function validateValue(
    value: unknown,
    kind: FieldKind,
    path: string,
    required: boolean,
    verdict: Verdict,
): void {
    if (absent(value)) {
        if (required) verdict.error(path, "missing-field", `'${leaf(path)}' is required`);
        return;
    }
    switch (kind.kind) {
        case "string":
            if (typeof value !== "string") verdict.error(path, "wrong-type", "expected a string");
            return;
        case "boolean":
            if (typeof value !== "boolean")
                verdict.error(path, "wrong-type", "expected true or false");
            return;
        case "size":
            validateSize(value, path, verdict);
            return;
        case "opacity":
            validateOpacity(value, path, verdict);
            return;
        case "enum":
            validateEnum(value, kind.members, path, verdict);
            return;
        case "dimensions":
            validateDimensions(value, path, verdict);
            return;
        case "background":
            validateBackground(value, path, verdict);
            return;
        case "border":
            validateBorder(value, path, verdict);
            return;
        case "imageSource":
            validateImageSource(value, path, verdict);
            return;
    }
}

function validateSize(value: unknown, path: string, verdict: Verdict): void {
    let size: bigint;
    if (typeof value === "bigint") {
        size = value;
    } else if (typeof value !== "number") {
        verdict.error(path, "wrong-type", "a size must be a number");
        return;
    } else if (!Number.isFinite(value)) {
        verdict.error(path, "wrong-type", `a size must be a finite number, got ${value}`);
        return;
    } else if (!Number.isInteger(value)) {
        verdict.error(
            path,
            "size-not-integer",
            `a size must be a whole number, got ${value}. Fractional sizes are refused, not rounded.`,
        );
        return;
    } else {
        size = BigInt(value);
    }

    if (size < 0n) {
        verdict.error(path, "size-negative", `a size cannot be negative, got ${size}`);
        return;
    }
    if (size > MAX_PROTOCOL_SIZE) {
        verdict.error(
            path,
            "size-too-large",
            `a size cannot be larger than ${MAX_PROTOCOL_SIZE}, got ${size}`,
        );
        return;
    }
    for (const limit of verdict.limits) {
        if (size > BigInt(limit.maxSizeValue)) {
            verdict.hostLimit(
                path,
                "host-limit-size",
                `${size} is past the largest size ${limit.name} draws (${limit.maxSizeValue})`,
            );
        }
    }
}

function validateOpacity(value: unknown, path: string, verdict: Verdict): void {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
        verdict.error(
            path,
            "opacity-out-of-range",
            `opacity must be a whole number from 0 to 255, got ${String(value)}`,
        );
    }
}

function validateEnum(
    value: unknown,
    members: readonly string[],
    path: string,
    verdict: Verdict,
): void {
    if (typeof value !== "string") {
        verdict.error(path, "wrong-type", "expected one of a fixed set of names");
        return;
    }
    if (!members.includes(value)) {
        verdict.error(path, "unknown-enum", `'${value}' is not one of: ${members.join(", ")}`);
    }
}

function validateDimensions(value: unknown, path: string, verdict: Verdict): void {
    const edges = readChild(value, path, verdict);
    if (edges === undefined) return;
    reportUnknownFields(edges, ["top", "end", "bottom", "start"], path, verdict);
    requiredEdge(edges, "top", path, verdict);
    requiredEdge(edges, "end", path, verdict);
    validateValue(edges.bottom, SIZE, `${path}.bottom`, false, verdict);
    validateValue(edges.start, SIZE, `${path}.start`, false, verdict);
}

function requiredEdge(
    edges: Record<string, unknown>,
    name: "top" | "end",
    path: string,
    verdict: Verdict,
): void {
    if (absent(edges[name])) {
        verdict.error(
            `${path}.${name}`,
            "missing-field",
            `'${name}' is required. ${DIMENSIONS_SHORTHAND}`,
        );
        return;
    }
    validateValue(edges[name], SIZE, `${path}.${name}`, true, verdict);
}

function validateBackground(value: unknown, path: string, verdict: Verdict): void {
    const fill = readChild(value, path, verdict);
    if (fill === undefined) return;
    reportUnknownFields(fill, ["color", "shape"], path, verdict);
    validateValue(
        fill.color,
        { kind: "enum", members: COLOR_TOKENS },
        `${path}.color`,
        true,
        verdict,
    );
    if (!absent(fill.shape)) validateShape(fill.shape, `${path}.shape`, verdict);
}

function validateBorder(value: unknown, path: string, verdict: Verdict): void {
    const stroke = readChild(value, path, verdict);
    if (stroke === undefined) return;
    reportUnknownFields(stroke, ["width", "color", "shape"], path, verdict);
    validateValue(stroke.width, SIZE, `${path}.width`, true, verdict);
    validateValue(
        stroke.color,
        { kind: "enum", members: COLOR_TOKENS },
        `${path}.color`,
        true,
        verdict,
    );
    if (!absent(stroke.shape)) validateShape(stroke.shape, `${path}.shape`, verdict);
}

function validateShape(value: unknown, path: string, verdict: Verdict): void {
    if (!isRecord(value)) {
        verdict.error(path, "not-an-object", "a shape must be a JSON object");
        return;
    }
    const tag = value.tag;
    if (typeof tag !== "string") {
        verdict.error(path, "missing-tag", "a shape needs a string 'tag'");
        return;
    }
    if (!(tag in SHAPE_SCHEMA)) {
        verdict.error(
            path,
            "unknown-shape",
            `unknown shape '${tag}'. Known shapes: ${Object.keys(SHAPE_SCHEMA).join(", ")}`,
        );
        return;
    }
    reportUnknownFields(value, ["tag", "value"], path, verdict);
    const kind = SHAPE_SCHEMA[tag];
    if (kind !== null) validateValue(value.value, kind, `${path}.value`, true, verdict);
}

function validateImageSource(value: unknown, path: string, verdict: Verdict): void {
    if (!isRecord(value)) {
        verdict.error(path, "not-an-object", "an image source must be a JSON object");
        return;
    }
    const tag = value.tag;
    if (typeof tag !== "string") {
        verdict.error(path, "missing-tag", "an image source needs a string 'tag'");
        return;
    }
    if (!(IMAGE_SOURCE_TAGS as readonly string[]).includes(tag)) {
        verdict.error(
            path,
            "unknown-image-source",
            `unknown image source '${tag}'. An image comes from a Bulletin CID or a path inside the product's own archive; the tree never carries a URL.`,
        );
        return;
    }
    reportUnknownFields(value, ["tag", "value"], path, verdict);
    validateValue(value.value, { kind: "string" }, `${path}.value`, true, verdict);
}

function reportUnknownFields(
    holder: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
    verdict: Verdict,
): void {
    for (const name of Object.keys(holder)) {
        if (allowed.includes(name)) continue;
        const expected = allowed.length === 0 ? "" : ` Expected one of: ${allowed.join(", ")}.`;
        verdict.warn(
            `${path}.${name}`,
            "unknown-field",
            `'${name}' is not part of this node, so the host ignores it.${expected}`,
        );
    }
}

/** Shapes the protocol allows and no product means. */
function advise(
    tag: string,
    value: Record<string, unknown>,
    props: Record<string, unknown>,
    path: string,
    verdict: Verdict,
): void {
    if (tag === "Button" && absent(props.clickAction)) {
        verdict.warn(
            `${path}.props`,
            "button-without-action",
            "a Button with no 'clickAction' is inert: the host has no id to report when it is pressed",
        );
    }
    if (tag === "TextField" && absent(props.valueChangeAction)) {
        verdict.warn(
            `${path}.props`,
            "text-field-without-action",
            "a TextField with no 'valueChangeAction' cannot report what was typed",
        );
    }
    if (tag === "Text" && !hasStringChild(value.children)) {
        verdict.warn(
            `${path}.children`,
            "text-without-content",
            "a Text draws nothing without a String child: its content belongs in children, not props",
        );
    }
}

function hasStringChild(children: unknown): boolean {
    return (
        Array.isArray(children) &&
        children.some((child) => isRecord(child) && child.tag === "String")
    );
}

/** Thrown by {@link assertFaceValid}. Carries the whole verdict, warnings included. */
export class FaceValidationError extends Error {
    constructor(readonly verdict: FaceVerdict) {
        super(`the face has ${verdict.errors.length} error(s):\n${describeIssues(verdict.errors)}`);
        this.name = "FaceValidationError";
    }
}

function describeIssues(issues: FaceIssue[]): string {
    return issues
        .map((issue) => `  ${issue.path === "" ? "<the face>" : issue.path}: ${issue.message}`)
        .join("\n");
}

/**
 * {@link validateFace}, but throws on any error.
 *
 * For a build step that should stop. Warnings do not throw: a build that failed
 * on advice would teach people to switch it off.
 */
export function assertFaceValid(face: unknown, options: ValidateFaceOptions = {}): void {
    const verdict = validateFace(face, options);
    if (!verdict.ok) throw new FaceValidationError(verdict);
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    /** The codes of every error, so a test can say what was wrong without matching prose. */
    const errorCodes = (face: unknown): string[] =>
        validateFace(face).errors.map((issue) => issue.code);

    const textNode = (content: string) => ({
        tag: "Text",
        value: {
            modifiers: [],
            props: { style: "BodyMediumRegular", color: "FgPrimary" },
            children: [{ tag: "String", value: { text: content } }],
        },
    });

    describe("a face that is right", () => {
        test("passes with no errors", () => {
            const verdict = validateFace({
                tag: "Column",
                value: {
                    modifiers: [{ tag: "Padding", value: { top: 16, end: 16 } }],
                    props: {},
                    children: [textNode("Loyalty")],
                },
            });
            expect(verdict.errors).toEqual([]);
            expect(verdict.ok).toBe(true);
        });

        // Every host treats absent and null alike for an optional field, and so
        // does the protocol's `Option`. A face that leaves out what it does not
        // need is idiomatic, not incomplete.
        test("accepts a node with no modifiers, props or children at all", () => {
            expect(validateFace({ tag: "Column" }).errors).toEqual([]);
        });

        test("accepts a Box with no children, which is how a filled rectangle is drawn", () => {
            const verdict = validateFace({
                tag: "Box",
                value: {
                    modifiers: [
                        { tag: "Width", value: 12 },
                        {
                            tag: "Background",
                            value: { color: "FgPrimary", shape: { tag: "Rounded", value: 3 } },
                        },
                    ],
                    props: {},
                    children: [],
                },
            });
            expect(verdict.errors).toEqual([]);
        });
    });

    describe("input handling", () => {
        test("parses a string and reports bad JSON rather than throwing", () => {
            expect(errorCodes("{ not json")).toEqual(["invalid-json"]);
        });

        test("accepts a face given as a JSON string", () => {
            expect(validateFace(JSON.stringify(textNode("hi"))).errors).toEqual([]);
        });

        test("refuses anything that is not an object", () => {
            expect(errorCodes(42)).toEqual(["not-an-object"]);
            expect(errorCodes(null)).toEqual(["not-an-object"]);
            expect(errorCodes([])).toEqual(["not-an-object"]);
        });
    });

    describe("the vocabulary is closed", () => {
        test("refuses an unknown node", () => {
            expect(errorCodes({ tag: "Gradient" })).toEqual(["unknown-node"]);
        });

        test("refuses an unknown modifier", () => {
            expect(
                errorCodes({ tag: "Column", value: { modifiers: [{ tag: "Glow", value: 1 }] } }),
            ).toEqual(["unknown-modifier"]);
        });

        test("refuses an unknown shape", () => {
            const face = {
                tag: "Box",
                value: {
                    modifiers: [
                        {
                            tag: "Background",
                            value: { color: "FgPrimary", shape: { tag: "Blob" } },
                        },
                    ],
                },
            };
            expect(errorCodes(face)).toEqual(["unknown-shape"]);
        });

        test("refuses an unknown image source", () => {
            const face = {
                tag: "Image",
                value: { props: { source: { tag: "Url", value: "https://x" } } },
            };
            expect(errorCodes(face)).toEqual(["unknown-image-source"]);
        });

        // Enum names are PascalCase. A product that writes a CSS colour, or the
        // Kotlin constant, gets the same refusal.
        test("refuses a colour outside the nine tokens", () => {
            const face = {
                tag: "Box",
                value: { modifiers: [{ tag: "Background", value: { color: "#00ff00" } }] },
            };
            expect(errorCodes(face)).toEqual(["unknown-enum"]);
        });

        test("names what was allowed when it refuses an enum", () => {
            const face = { tag: "Text", value: { props: { style: "Huge" } } };
            const [issue] = validateFace(face).errors;
            expect(issue.code).toBe("unknown-enum");
            expect(issue.message).toContain("TitleMediumRegular");
            expect(issue.path).toBe(".value.props.style");
        });
    });

    describe("required fields", () => {
        // The single most expensive encoding trap: `Padding` and `Margin` are a
        // shorthand where `bottom` defaults to `top` and `start` to `end`, so a
        // caller who writes only `top` has not written "16 on top" — they have
        // written a missing field.
        test("refuses a Padding with no end, and says why", () => {
            const face = {
                tag: "Column",
                value: { modifiers: [{ tag: "Padding", value: { top: 16 } }] },
            };
            const [issue] = validateFace(face).errors;
            expect(issue.code).toBe("missing-field");
            expect(issue.path).toBe(".value.modifiers[0].value.end");
            expect(issue.message).toContain("shorthand");
        });

        test("refuses a Button with no text", () => {
            expect(errorCodes({ tag: "Button", value: { props: { clickAction: "go" } } })).toEqual([
                "missing-field",
            ]);
        });

        test("refuses an Image with no source", () => {
            expect(errorCodes({ tag: "Image", value: { props: { fit: "Cover" } } })).toEqual([
                "missing-field",
            ]);
        });

        test("refuses an Effect with no effect", () => {
            expect(errorCodes({ tag: "Effect", value: { props: {}, children: [] } })).toEqual([
                "missing-field",
            ]);
        });

        test("refuses a String with no text", () => {
            expect(errorCodes({ tag: "String", value: {} })).toEqual(["missing-field"]);
        });
    });

    describe("sizes", () => {
        // A fractional size is refused, not rounded. Finding that out on a phone
        // is the loop this whole package exists to shorten.
        test("refuses a fractional size and says it is not rounded", () => {
            const face = { tag: "Column", value: { modifiers: [{ tag: "Width", value: 16.5 }] } };
            const [issue] = validateFace(face).errors;
            expect(issue.code).toBe("size-not-integer");
            expect(issue.message).toContain("not rounded");
        });

        test("refuses a negative size", () => {
            const face = { tag: "Column", value: { modifiers: [{ tag: "Height", value: -1 }] } };
            expect(errorCodes(face)).toEqual(["size-negative"]);
        });

        test("accepts zero", () => {
            const face = { tag: "Column", value: { modifiers: [{ tag: "Height", value: 0 }] } };
            expect(errorCodes(face)).toEqual([]);
        });

        test("refuses a size that is not a number", () => {
            const face = { tag: "Column", value: { modifiers: [{ tag: "Width", value: "16" }] } };
            expect(errorCodes(face)).toEqual(["wrong-type"]);
        });
    });

    describe("opacity", () => {
        // Opacity is a u8 on the wire. 256 is not "nearly opaque", it is a
        // different number entirely once it wraps.
        test("refuses a value outside 0..255", () => {
            const face = { tag: "Column", value: { modifiers: [{ tag: "Opacity", value: 256 }] } };
            expect(errorCodes(face)).toEqual(["opacity-out-of-range"]);
        });

        test("accepts the ends of the range", () => {
            for (const value of [0, 255]) {
                const face = { tag: "Column", value: { modifiers: [{ tag: "Opacity", value }] } };
                expect(errorCodes(face)).toEqual([]);
            }
        });
    });

    describe("reporting", () => {
        // Four typos should take one run to fix, not four.
        test("collects every error rather than stopping at the first", () => {
            const face = {
                tag: "Column",
                value: {
                    modifiers: [
                        { tag: "Width", value: 1.5 },
                        { tag: "Opacity", value: 900 },
                    ],
                    children: [{ tag: "Nope" }],
                },
            };
            expect(errorCodes(face)).toEqual([
                "size-not-integer",
                "opacity-out-of-range",
                "unknown-node",
            ]);
        });

        test("points at the node, not just the problem", () => {
            const face = {
                tag: "Column",
                value: { children: [{ tag: "Column", value: { children: [{ tag: "X" }] } }] },
            };
            const [issue] = validateFace(face).errors;
            expect(issue.path).toBe(".value.children[0].value.children[0]");
        });
    });

    describe("warnings: what the protocol allows and no product means", () => {
        // Every host ignores a field it does not recognise, so a misspelled prop
        // does nothing and says nothing. This is the class the warning severity
        // exists for.
        test("warns about a misspelled prop rather than refusing it", () => {
            const face = {
                tag: "Text",
                value: {
                    props: { colour: "FgPrimary" },
                    children: [{ tag: "String", value: { text: "x" } }],
                },
            };
            const verdict = validateFace(face);
            expect(verdict.ok).toBe(true);
            expect(verdict.warnings.map((issue) => issue.code)).toEqual(["unknown-field"]);
            expect(verdict.warnings[0].path).toBe(".value.props.colour");
        });

        test("warns about a Button that cannot report a press", () => {
            const verdict = validateFace({ tag: "Button", value: { props: { text: "Add" } } });
            expect(verdict.ok).toBe(true);
            expect(verdict.warnings.map((issue) => issue.code)).toEqual(["button-without-action"]);
        });

        test("warns about a TextField that cannot report what was typed", () => {
            const verdict = validateFace({ tag: "TextField", value: { props: { text: "" } } });
            expect(verdict.warnings.map((issue) => issue.code)).toEqual([
                "text-field-without-action",
            ]);
        });

        // A Text whose content went into props draws empty. The face is valid and
        // the card is blank, which is the worst pair to debug on a phone.
        test("warns about a Text with no String child", () => {
            const face = {
                tag: "Text",
                value: { props: { style: "BodyMediumRegular" }, children: [] },
            };
            expect(validateFace(face).warnings.map((issue) => issue.code)).toEqual([
                "text-without-content",
            ]);
        });

        test("a face that is right draws no warnings", () => {
            expect(validateFace(textNode("fine")).warnings).toEqual([]);
        });
    });

    describe("host bounds are advice until a host is named", () => {
        /** A tree `levels` nodes deep, counting the root as level 1. */
        const deep = (levels: number): unknown => {
            let node: unknown = { tag: "Nil" };
            for (let level = 1; level < levels; level += 1) {
                node = { tag: "Column", value: { children: [node] } };
            }
            return node;
        };

        // Android's bounds are one app's constants, not the protocol. A product
        // writing against the protocol is told about them; a product about to
        // ship to that app asks for them and is stopped by them.
        test("a tree past android's depth is a warning by default", () => {
            const verdict = validateFace(deep(33));
            expect(verdict.ok).toBe(true);
            expect(verdict.warnings.map((issue) => issue.code)).toEqual(["host-limit-depth"]);
            expect(verdict.warnings[0].message).toContain("android");
        });

        test("the same tree is an error when android is named", () => {
            const verdict = validateFace(deep(33), { host: androidLimits });
            expect(verdict.ok).toBe(false);
            expect(verdict.errors.map((issue) => issue.code)).toEqual(["host-limit-depth"]);
        });

        test("exactly at the bound is fine", () => {
            expect(validateFace(deep(32), { host: androidLimits }).errors).toEqual([]);
        });

        // The protocol's ceiling is 2^64-1; android's is Int.MAX_VALUE because its
        // tree maps into Compose. A size between the two is legal protocol and
        // undrawable there, which is exactly what the two severities are for.
        test("a size past android's ceiling is reported against that ceiling", () => {
            const face = {
                tag: "Column",
                value: { modifiers: [{ tag: "Width", value: 2147483648 }] },
            };
            expect(validateFace(face).warnings.map((issue) => issue.code)).toEqual([
                "host-limit-size",
            ]);
            expect(
                validateFace(face, { host: androidLimits }).errors.map((issue) => issue.code),
            ).toEqual(["host-limit-size"]);
        });

        test("a face past android's byte cap is measured as JSON text", () => {
            const face = {
                tag: "Text",
                value: {
                    props: {},
                    children: [{ tag: "String", value: { text: "x".repeat(300_000) } }],
                },
            };
            const verdict = validateFace(face, { host: androidLimits });
            expect(verdict.errors.map((issue) => issue.code)).toContain("host-limit-bytes");
        });
    });
    describe("assertFaceValid", () => {
        test("passes a face that is right", () => {
            expect(() => assertFaceValid(textNode("fine"))).not.toThrow();
        });

        // A build step should learn everything that is wrong in one run, not one
        // problem per rebuild.
        test("throws once, carrying every error", () => {
            const face = {
                tag: "Column",
                value: {
                    modifiers: [
                        { tag: "Width", value: 1.5 },
                        { tag: "Opacity", value: 900 },
                    ],
                },
            };
            let thrown: unknown;
            try {
                assertFaceValid(face);
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(FaceValidationError);
            expect((thrown as FaceValidationError).verdict.errors).toHaveLength(2);
            expect((thrown as FaceValidationError).message).toContain("refused, not rounded");
        });

        // Warnings are advice. A build that stopped on them would train people to
        // turn it off.
        test("does not throw on warnings alone", () => {
            expect(() =>
                assertFaceValid({ tag: "Button", value: { props: { text: "Add" } } }),
            ).not.toThrow();
        });
    });
}
