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
 * This package is the protocol as data, plus a checker. {@link validateFace}
 * holds a finished tree against the vocabulary, so a face is wrong at build
 * time rather than blank on a phone, and {@link NODE_SCHEMA} lets anything that
 * builds trees hold its own coverage against the protocol.
 *
 * To write a face, reach for `@parity/product-sdk-react-renderer`, which
 * authors one in JSX. Nothing here is specific to Pocket, and nothing here
 * talks to a host.
 *
 * @packageDocumentation
 */
export { MODIFIER_SCHEMA, NODE_SCHEMA } from "./schema.js";
export type { Field, FieldKind, NodeSchema } from "./schema.js";

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
