---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Surface a clear error when a host reply can't be decoded, instead of an opaque `RangeError`.**

When the host app and the `@parity/truapi` version a product is built against are on different protocol versions, a host call can return a frame the client's SCALE codec can't decode. The truapi client builds each call's `ResultAsync` with `fromSafePromise`, which assumes the underlying promise never rejects — but the decode runs inside that promise and *can* throw, so the failure escaped the `Result` channel as an unhandled `RangeError: Offset is outside the bounds of the DataView` from inside the transport's message handler, with a stack that named neither the call nor the cause (reported for `createRingVRFProof`).

`getAccountsProvider()`'s methods now route that throw onto the `Result` err channel as a new `HostResponseDecodeError` that names the failing call (e.g. `"createRingVRFProof"`) and preserves the original error as `cause`. Well-formed responses and each call's own typed `Err` values pass through untouched.

New exports: the `HostResponseDecodeError` class (extends `HostError`, so `isHostError` / `instanceof HostError` catch it) and the `WithDecodeError<E>` type alias. Every `AccountsProvider` lookup method's `err` type is widened to `WithDecodeError<…>`; consumers matching on the err channel gain one additional case.
