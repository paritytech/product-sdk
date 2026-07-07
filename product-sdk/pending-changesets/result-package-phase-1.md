---
"@parity/product-sdk-result": minor
"@parity/product-sdk-host": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk": minor
---

Add `@parity/product-sdk-result` — a zero-dependency leaf exporting the shared `Result<T, E>` type (`ok` / `err`) and the cross-package `SdkError` marker interface (`isSdkError`). It gives the SDK one canonical `Result` definition and lets any consumer identify an SDK-origin error with a single `isSdkError(e)` check, regardless of which package raised it.

`@parity/product-sdk-host` and `@parity/product-sdk-signer` now consume this shared package instead of each maintaining their own local `Result` copy, and their base errors (`HostError`, `SignerError`) implement `SdkError` (additive — no public API change). Both packages re-export `SdkError` / `isSdkError`.
