---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

`createFakeTruApiClient` models `localStorage.subscribe`, so a product test can
exercise a key watcher without a real host. The fake's in-memory KV is the
source of truth for the stream: a subscription delivers the key's current value
on a microtask, then one item per later `write` or `clear` that changes the
stored bytes. A write of the bytes already stored, and a clear of an absent key,
emit nothing — the same silence the host keeps. `unsubscribe()` stops delivery.

```ts
using host = createFakeHost({ localStorage: { theme: new TextEncoder().encode("dark") } });
host.client.localStorage
    .subscribe({ request: { key: "theme" } })
    .subscribe({ next: ({ value }) => render(value) });
```
