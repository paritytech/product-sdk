// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-result — the shared, zero-dependency `Result` type and
 * `SdkError` marker for the `@parity/product-sdk` family.
 *
 * @packageDocumentation
 */
export { type Result, ok, err } from "./result.js";
export { type SdkError, isSdkError } from "./error.js";
