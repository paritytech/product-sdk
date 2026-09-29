// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-renderer — Build and validate renderer trees.
 *
 * The host draws a Pocket card face, and a rendered chat body, from a
 * `RendererNode`: a closed vocabulary of layout and design tokens resolved by
 * the host's own theme. A product names structure, never markup, colours or
 * URLs.
 *
 * Two halves. The builders construct that vocabulary with the compiler
 * checking the names and shapes. {@link validateFace} checks a finished tree
 * against the protocol, so a face is wrong at build time rather than blank on
 * a phone.
 *
 * Nothing here is specific to Pocket, and nothing here talks to a host.
 *
 * @packageDocumentation
 */
export {
    nil,
    str,
    text,
    column,
    row,
    box,
    spacer,
    button,
    textField,
    image,
    effect,
} from "./nodes.js";
export type {
    BoxOptions,
    ButtonOptions,
    ColumnOptions,
    ImageOptions,
    NodeOptions,
    RowOptions,
    SpacerOptions,
    TextFieldOptions,
    TextOptions,
} from "./nodes.js";

export {
    archive,
    background,
    blendingMode,
    border,
    bulletin,
    circle,
    fillHeight,
    fillWidth,
    height,
    margin,
    marginEach,
    minHeight,
    minWidth,
    opacity,
    padding,
    paddingEach,
    rounded,
    square,
    width,
} from "./modifiers.js";

export { assertFaceValid, FaceValidationError, validateFace } from "./validate.js";
export type { FaceIssue, FaceIssueCode, FaceVerdict, ValidateFaceOptions } from "./validate.js";

export { androidLimits, KNOWN_HOST_LIMITS } from "./limits.js";
export type { HostLimits } from "./limits.js";

/** The protocol's own vocabulary types, re-exported so one import covers a face. */
export type {
    Arrangement,
    BlendingMode,
    ButtonVariant,
    ColorToken,
    ContentAlignment,
    Dimensions,
    Effect,
    HorizontalAlignment,
    ImageFit,
    ImageSource,
    Modifier,
    RendererNode,
    Shape,
    Size,
    TypographyStyle,
    VerticalAlignment,
} from "@parity/truapi";
