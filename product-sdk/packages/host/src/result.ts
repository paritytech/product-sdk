// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Re-export of the shared `Result` primitive from `@parity/result`.
 *
 * Host functions return `Promise<Result<T, HostError>>` rather than throwing, so
 * consumers get typed errors on the `err` channel. The type is now owned by the
 * zero-dependency `@parity/result` leaf so every package shares one
 * definition; this module stays as the host-internal import path.
 *
 * @module
 */
export { type Result, ok, err } from "@parity/result";
