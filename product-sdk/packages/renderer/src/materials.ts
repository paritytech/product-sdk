// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers for the arguments of a `Materials` layer.
 *
 * @module
 */

const scratch = new DataView(new ArrayBuffer(4));

/**
 * The IEEE 754 single-precision bit pattern of `value`, as the protocol
 * carries a material's numbers.
 *
 * A `Float` or `VecN` argument holds bits, not the float itself, so `0.5` is
 * written `floatBits(0.5)`. Values round to the nearest single-precision float.
 *
 * @example
 * ```ts
 * const layer = { material, args: [{ tag: "Float", value: floatBits(0.5) }] };
 * ```
 */
export function floatBits(value: number): number {
    scratch.setFloat32(0, value);
    return scratch.getUint32(0);
}
