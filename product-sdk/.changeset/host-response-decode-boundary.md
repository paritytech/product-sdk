---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Surface a clear error when a host reply can't be decoded, instead of an opaque `RangeError`.**

When the host app and the `@parity/truapi` version a product is built against are on different protocol versions, a host call can return a frame the client's SCALE codec can't decode. The truapi client catches that decode throw in its message handler and turns it into a promise rejection, then wraps the call with `fromSafePromise`, which installs no rejection handler — so the rejection escaped the `Result` channel rather than landing on its err side, surfacing as a raw `RangeError: Offset is outside the bounds of the DataView` with a stack that named neither the call nor the cause (reported for `createRingVRFProof`).

The host boundaries now re-home that rejection onto the `Result` err channel (or, for the throwing helper, as a typed throw) as a new `HostResponseDecodeError` that names the failing call and preserves the original error as `cause`. This covers every path: `getAccountsProvider()`'s ten lookup methods, the flat public operations that fold through `mapHostResult` (`requestPermission`, `deriveEntropy`, `requestResourceAllocation`, …), and the adapter-object / signer methods that go through `unwrapHostResult`. Well-formed responses and each call's own typed `Err` values pass through untouched.

New exports: the `HostResponseDecodeError` class (extends `HostError`, so `isHostError` / `instanceof HostError` catch it) and the `WithDecodeError<E>` type alias. Every `AccountsProvider` lookup method's `err` type is widened to `WithDecodeError<…>`; consumers matching on the err channel gain one additional case.
