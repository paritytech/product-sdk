---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

**Pair with a truapi 0.18 host.** `@parity/truapi` moves from `^0.17.0` to `^0.18.0`. `TRUAPI_CODEC_VERSION` moves from 2 to 3 and `TRUAPI_WIRE_SCHEMA_HASH` from `50637d83426acd22` to `462dacb6e0d1f504`. The handshake compares codec versions for equality, so a product on 0.18 cannot talk to a host still on 0.17, in either direction — every host surface has to move in the same window.

**New `worker` domain.** `getTruApi().worker` exposes the product's pending background operations: `beginOperation()` opens one and `endOperation()` closes it, and the host keeps a `Worker` product's runtime alive while at least one is open. `endOperation` is idempotent, so a retry after an ambiguous failure is safe. `createFakeTruApiClient` from `@parity/product-sdk-host/testing` carries a `worker` entry that throws when touched, matching how the other unmodeled domains behave.

**New `localStorage.subscribe`.** `getTruApi().localStorage.subscribe({ request })` emits a key's current value and then one item per later write or clear of that key by any of the product's runtimes; a write that leaves the bytes unchanged emits nothing. The fake client's `localStorage` still serves `read` / `write` / `clear` from its real in-memory KV, but `subscribe` is not modeled and throws — a test that needs it should drive the real transport instead.

**Call errors can now be `Cancelled`.** `CallErrorValue` gains a `Cancelled` unit variant, which the host returns for a call it stopped. Code that exhaustively matches on a call error's `tag` needs a new arm; code that formats by tag — including this package's own `formatHostError` — is unaffected.

**Every call takes an optional `CallOptions`.** Generated request methods accept a trailing `{ signal }` argument for withdrawing a call. A host predating the cancel leg drops the frame, and the call settles on its deadline instead; there is no way to detect that in advance. This package does not yet surface the option through its own facades.

**Minor rather than patch**, which on 0.x signals a breaking change. This package's own API is unchanged; the break is the wire codec and what it can talk to.
