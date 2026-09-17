---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
---

**Pair with a truapi 0.17 host.** `@parity/truapi` moves from `^0.16.0` to `^0.17.0`. The codec version stays at 2, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `e883e2c0b9857933` to `50637d83426acd22`, so the schema a product speaks no longer matches a host still on 0.16. Every host surface has to move in the same window, exactly as it did for the codec-1 to codec-2 jump.

**New `pocket` domain.** `getTruApi().pocket` exposes the product's own pocket cards: `listSubscribe()` emits the whole set on subscribe and again after every change, and `removeCard()` removes one. The host owns the collection, so a product can observe and remove its cards but cannot add one. Removing a card that is not present succeeds; a privileged card is refused with `Privileged`. `createFakeTruApiClient` from `@parity/product-sdk-host/testing` carries a `pocket` entry that throws when touched, matching how the other unmodeled domains behave.

**Subscription errors are no longer `GenericError`.** Nine subscriptions now carry a per-call versioned error union instead: account connection status, chain head follow, chat list, chat action, locale, preimage lookup, renderer render, renderer action, and theme. Code that narrowed on `GenericError` in a subscription error handler needs to narrow on the specific union instead.

**Minor rather than patch**, which on 0.x signals a breaking change. This package's own API is unchanged; the break is in the error types that flow through it and in what it can talk to.
