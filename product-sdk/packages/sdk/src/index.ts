// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk
 *
 * Unified SDK for building products on the Polkadot ecosystem.
 *
 * @example
 * ```ts
 * import { createApp } from '@parity/product-sdk';
 *
 * const app = createApp({
 *   name: 'my-app',
 *   logLevel: 'info',
 * });
 *
 * // Connect wallet
 * const { accounts } = await app.wallet.connect();
 *
 * // Use storage
 * await app.localStorage.set('key', 'value');
 * ```
 *
 * @packageDocumentation
 */

// Core exports
export { createApp } from "./core/createApp.js";
export { configure, createLogger } from "./core/logger.js";
export type {
    App,
    AppConfig,
    LogLevel,
    WalletApi,
    LocalStorageApi,
    ChainApi,
    CloudStorageApi,
    Account,
    DotNsIdentitySignature,
    SignMessageWithDotNsIdentityArgs,
    ChainClient,
    ChainDefinition,
    TypedApi,
    PolkadotClient,
} from "./core/types.js";
export type { LogEntry, LogHandler, LoggerConfig, Logger } from "./core/logger.js";

// The throw→Result model. Every fallible SDK operation returns `Result<T, E>`.
// `Result`/`ok`/`err`/`isErrorOf` come from the generic `@parity/result`; the
// cross-package `SdkError` marker (`isSdkError` recognizes any error raised by
// an `@parity/product-sdk-*` package) lives in `@parity/product-sdk-errors`.
export { ok, err, isErrorOf } from "@parity/result";
export type { Result } from "@parity/result";
export { type SdkError, isSdkError } from "@parity/product-sdk-errors";

// Re-export common utilities from leaf packages
export { isInsideContainer, isInsideContainerSync } from "@parity/product-sdk-host";
export { createChainClient } from "@parity/product-sdk-chain-client";
export { SignerManager } from "@parity/product-sdk-signer";
export { createLocalKvStore } from "@parity/product-sdk-local-storage";
export { CloudStorageClient, calculateCid } from "@parity/product-sdk-cloud-storage";
