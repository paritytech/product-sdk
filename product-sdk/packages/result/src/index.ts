// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/result — a generic, zero-dependency tagged `Result` type and helpers.
 *
 * Domain-agnostic: it carries no product-sdk specifics, so it can be embedded
 * anywhere (including upstream in `@parity/truapi`). The product-sdk error
 * taxonomy (`SdkError`) lives in `@parity/product-sdk-errors`.
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
    isErrorOf,
} from "./result.js";
