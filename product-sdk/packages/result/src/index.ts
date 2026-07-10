// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/result — the shared, zero-dependency `Result` type and
 * `SdkError` marker for the `@parity/product-sdk` family.
 *
 * @packageDocumentation
 */
export {
    type Result,
    type ErrorClass,
    ok,
    err,
    unwrapOk,
    unwrapErr,
    normalizeError,
} from "./result.js";
export { type SdkError, isSdkError } from "./error.js";
