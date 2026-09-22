// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * What individual hosts will draw, as data.
 *
 * None of this is protocol. The unified-renderer RFC says a tree deeper than
 * *the host's* bound is a decode failure, and neither RFC mentions a byte cap
 * at all — these are one app's constants. They live here as plain records so a
 * product can write a face against the shared protocol and owe nothing to any
 * particular renderer, then ask about a specific host when it is about to ship
 * to one.
 *
 * @module
 */

/** One host's own bounds. */
export interface HostLimits {
    /** Named in every message about these bounds, so advice says who is asking. */
    name: string;
    /** Deepest tree the host will decode, counting the root as level 1. */
    maxDepth: number;
    /** Largest value a `Size` may carry. */
    maxSizeValue: number;
    /** Largest face, measured as JSON text in bytes. */
    maxBytes: number;
}

/**
 * The Polkadot Android app.
 *
 * `maxDepth` and `maxSizeValue` come from its `RendererNodeJsonDecoder`, where
 * the size ceiling is `Int.MAX_VALUE` because the tree maps into Compose, which
 * reads a size back as an `Int`. `maxBytes` is its `MAX_FACE_BYTES`, applied
 * both to a streamed face and to a preview file in the worker archive.
 */
export const androidLimits: HostLimits = {
    name: "android",
    maxDepth: 32,
    maxSizeValue: 2147483647,
    maxBytes: 262144,
};

/**
 * Every host whose bounds we know.
 *
 * A caller who names no host is checked against all of these, as advice. The
 * iOS app has no renderer yet; it joins this list when it does.
 */
export const KNOWN_HOST_LIMITS: readonly HostLimits[] = [androidLimits];
