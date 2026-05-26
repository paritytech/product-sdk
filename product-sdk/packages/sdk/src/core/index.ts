// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk core module
 *
 * Core functionality including createApp, logger, and type definitions.
 */

export { createApp } from "./createApp.js";
export { configure, createLogger } from "./logger.js";
export type { LogEntry, LogHandler, LoggerConfig, Logger } from "./logger.js";
export * from "./types.js";
