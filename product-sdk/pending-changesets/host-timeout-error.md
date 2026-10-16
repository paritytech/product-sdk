---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**A host call that gets no answer in time fails with `HostTimeoutError`, whose message no longer blames a protocol-version skew.**

A truapi `RequestTimeoutError` becomes `HostTimeoutError`, which names the call and how long the client waited, and keeps the original error as `cause`. It is a subclass of `HostResponseDecodeError`, so existing `instanceof HostResponseDecodeError` checks and `WithDecodeError<E>` still cover it; check `instanceof HostTimeoutError` to tell a timeout apart.
