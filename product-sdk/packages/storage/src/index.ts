/**
 * @parity/product-sdk-storage — One key-value API across the host container and the browser.
 *
 * `createKvStore` returns a `KvStore` that uses the host-provided
 * `HostLocalStorage` when running inside a Polkadot host container and falls back
 * to browser `localStorage` otherwise, so app code reads and writes the same way
 * on desktop, mobile, and web.
 *
 * @packageDocumentation
 */
export { createKvStore } from "./kv-store.js";
export type { KvStore, KvStoreOptions } from "./types.js";
export type { HostLocalStorage } from "@parity/product-sdk-host";
