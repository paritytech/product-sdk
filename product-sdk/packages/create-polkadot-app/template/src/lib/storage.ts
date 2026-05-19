// Host-aware local key-value storage.
//
// `createKvStore` transparently picks the right backend: inside a
// Polkadot host container it uses the host's durable storage, scoped to
// the dApp; outside, it uses browser localStorage. The `prefix` option
// scopes keys per feature so multiple features can coexist.
//
// Usage:
//   import { getStore } from "./lib/storage";
//   const store = await getStore("my-feature");
//   await store.set("key", "value");
//   const value = await store.get("key");        // string | null
//   await store.setJSON("obj", { a: 1 });
//   const obj = await store.getJSON<{ a: number }>("obj");
//
// Reference: `storage-demo` in the @parity/product-sdk repo.

import { createKvStore } from "@parity/product-sdk-storage";
import type { KvStore } from "@parity/product-sdk-storage";

const stores = new Map<string, Promise<KvStore>>();

export function getStore(prefix = "app"): Promise<KvStore> {
  let p = stores.get(prefix);
  if (!p) {
    p = createKvStore({ prefix });
    stores.set(prefix, p);
  }
  return p;
}
