// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-local-storage — Key-value storage backed by the host container.
 *
 * `createLocalKvStore` returns a `LocalKvStore` backed by the host-provided
 * `HostLocalStorage`. It runs only inside a Polkadot host container (Browser /
 * Desktop) and throws if host storage is unavailable.
 *
 * For records of their own, products use the byte-level `ByteStore`, and
 * `openJournaledStore` for changes to several keys that land whole or not at all,
 * with `PagedIndex` and `ClaimSet` for the indexes and one-time claims host
 * storage cannot list.
 *
 * @packageDocumentation
 */
export { createLocalKvStore } from "./kv-store.js";
export {
    decodeRecord,
    encodeRecord,
    getHostByteStore,
    hostByteStore,
    openJournaledStore,
} from "./journal.js";
export type { ByteStore, JournalEntry, JournaledStore } from "./journal.js";
export { CLAIM_BUCKETS, ClaimSet, INDEX_PAGE_SIZE, PagedIndex } from "./paged-index.js";
export type { IndexEntry } from "./paged-index.js";
export type { LocalKvStore, LocalKvStoreOptions } from "./types.js";
export type { HostLocalStorage } from "@parity/product-sdk-host";
