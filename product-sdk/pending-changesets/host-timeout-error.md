---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**A host call that gets no answer in time now fails with `HostTimeoutError` instead of `HostResponseDecodeError`.**

`HostResponseDecodeError` described every rejected call as a likely protocol-version skew, so a call the host never answered (for example a resource allocation the person had not approved yet) pointed at the wrong cause. A truapi `RequestTimeoutError` now becomes `HostTimeoutError`, which names the call and how long the client waited, and keeps the original error as `cause`. `HostResponseDecodeError` now covers only replies that could not be decoded or a channel that closed mid-call.

**Breaking for code that matches on the err channel.** `WithDecodeError<E>` includes `HostTimeoutError`, and `unwrapHostResult`-based methods throw it on timeout. Code that caught timeouts with `instanceof HostResponseDecodeError` must check `HostTimeoutError` instead; `instanceof HostError` and `isHostError` still catch both.
