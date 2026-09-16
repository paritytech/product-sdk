---
"@parity/product-sdk-host": minor
---

**Pair with a codec-2 host.** `@parity/truapi` moves from `^0.13.1` to `^0.16.0`, which changes the wire envelope from codec 1 to codec 2.

The two codecs cannot negotiate. The handshake itself rides the changed envelope, so there is no version exchange to fall back on: a host still on codec 1 drops a codec-2 frame as an unroutable message type and answers nothing, and the call times out rather than failing fast. The same holds in reverse, so a product on this SDK talks only to a host that moved with it.

**Every host surface moves in the same window.** The desktop host takes `@parity/truapi-host` 0.16.0; the iOS app resolves the `@parity/ios-host` 0.16.0 SwiftPM tag; the Android app pins the same commit and builds the core from source. A product rebuilt on this SDK will not work against a host that has not been updated, and a host that has been updated will not serve a product that has not.

**Minor rather than patch**, which on 0.x signals a breaking change. Nothing in this package's own API changes: the break is in what it can talk to.
