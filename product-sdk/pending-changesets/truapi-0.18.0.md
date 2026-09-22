---
"@parity/product-sdk-host": patch
---

Update `@parity/truapi` to 0.18.0 (from 0.16.0). Unlike the 0.13.1 bump this is
not a no-op: the client surface grows two domains (`pocket`, `worker`), the
`localStorage` domain gains a `subscribe` method, every call takes an optional
`CallOptions`, and the wire codec version moves 2 to 3. No SDK call sites change
(the new params are optional), but the host testing fake now models
`localStorage.subscribe` as an inert observable and the two new domains as
not-modeled, so a consumer's test run fails loudly on them rather than with
`undefined is not a function`.
