// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-local-storage — Key-value storage backed by the host container.
 *
 * `createLocalKvStore` returns a `LocalKvStore` backed by the host-provided
 * `HostLocalStorage`. It runs only inside a Polkadot host container (Browser /
 * Desktop) and throws if host storage is unavailable.
 *
 * @packageDocumentation
 */
export { createLocalKvStore } from "./kv-store.js";
export type { LocalKvStore, LocalKvStoreOptions } from "./types.js";
export type { HostLocalStorage } from "@parity/product-sdk-host";
