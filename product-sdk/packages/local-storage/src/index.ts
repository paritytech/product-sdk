// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-local-storage — One key-value API across the host container and the browser.
 *
 * `createLocalKvStore` returns a `LocalKvStore` that uses the host-provided
 * `HostLocalStorage` when running inside a Polkadot host container and falls back
 * to browser `localStorage` otherwise, so app code reads and writes the same way
 * on desktop, mobile, and web.
 *
 * @packageDocumentation
 */
export { createLocalKvStore } from "./kv-store.js";
export type { LocalKvStore, LocalKvStoreOptions } from "./types.js";
export type { HostLocalStorage } from "@parity/product-sdk-host";
