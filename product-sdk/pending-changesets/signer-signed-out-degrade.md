---
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Degrade gracefully when resolving a product account while signed out (#253).**

When `HostProvider` is configured with `productAccount` and `connect()` runs
without an active user session, the signed-out (`NotConnected`) state was
treated as a fault: logged at `error` level with an opaque `{ cause }` payload
(which serialized to `{}`), and retried up to 3× by `connect()`. It now
soft-degrades to an empty accounts list (read-only), mirroring the `dappName`
branch — signed-out and unregistered-identifier (`DomainNotValid`) failures log
at `debug`/`warn` and skip retries, while genuine transient faults still error
and retry.

All host-RPC error logs in `host.ts` now serialize a readable message
(`{ error: <message> }`) instead of the opaque `{ cause }`, so structured log
sinks show the actual reason. `HostRejectedError` gains a `nonTransient` flag
carrying the classification.
