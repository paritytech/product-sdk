---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Add `getWorkerManager()` — call this product's own background worker from its rendered surface.**

A product ships two executables: the web application a host renders, and a single background worker published at `worker.<product_id>.<tld>`. They run in different sandboxes and cannot reach each other directly. `getWorkerManager()` is the host-mediated path between them, following the same singleton-accessor shape as `getNotificationManager` and `getPaymentManager`.

`call(apiName, payload, options?)` invokes an export the worker archive already declared and resolves to its result. What crosses is data, never code: the host resolves `apiName` against the pinned, verified worker bundle, so a page cannot hand the worker a function, a script, or an import path. That boundary matters because worker authority is wider than the page's — anything able to inject into the page would otherwise inherit it.

The page never names the product either. The host supplies the product identity from the surface it is rendering, so the call can only ever reach your own worker.

`isAvailable()` reports whether the host installs the bridge at all. It returns `false` outside a host container and on hosts that predate the bridge, which is every shipping host until the host-side change lands.

**Errors.** `WorkerCallError` carries the host's frozen tag set as `tag`: `unavailable`, `denied`, `invalid`, `timeout`, `crashed`, `version`. Branch on `unavailable` — it is the normal answer when the product ships no worker, the user has disabled it, the manifest declares no ceiling for this surface, or the worker is in crash quarantine. An unrecognised tag from a future host degrades to `unavailable` rather than throwing something unhandleable. Calling with no host bridge present throws `HostUnavailableError`, consistent with the other host wrappers.

**Opt in on chain, not in code.** The host only routes the call when the worker manifest declares the surface in its `includes` ceiling. A worker published without it answers `unavailable`, exactly as a host with no worker support would, so a publisher decides this at publish time where the host can read it while the page is closed.
