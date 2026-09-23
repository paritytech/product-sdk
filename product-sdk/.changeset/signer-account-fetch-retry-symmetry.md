---
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**`connect()` no longer reports success with no accounts after a recoverable failure.** The two branches that fetch a product account now classify failures the same way. The `productAccount` branch already degraded to an empty account list only for a non-transient rejection and returned anything else for the retry loop; the `dappName` branch — the one a default `SignerManager` takes — degraded on *any* failure, so a timeout was indistinguishable from an unregistered identifier and `connect()` resolved `ok([])` with nothing to prompt another attempt. Both now share one classifier.

**`NotConnected` is retried before it degrades.** The host returns that tag both for a signed-out user and for a session that is being re-established — after a host account switch, the core re-mints it, and a product account queried in that window is refused. The two are indistinguishable, so the tag is now retried and degrades to read-only only once the attempts are spent. A signed-out user reaches the same empty-accounts state as before, a retry cycle later; an in-flight re-mint recovers instead of leaving the product connected with no accounts.

Consumers passing `dappName` who relied on `connect()` always resolving should note it can now return an error for an unclassified host failure, after `maxRetries` attempts.
