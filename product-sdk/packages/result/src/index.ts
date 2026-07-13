// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/result — a generic, zero-dependency tagged `Result` type and helpers.
 *
 * Domain-agnostic: it carries no application-specific concepts, so it can be
 * imported anywhere without cycles.
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
