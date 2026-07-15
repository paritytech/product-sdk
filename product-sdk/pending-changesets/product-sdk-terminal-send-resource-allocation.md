---
"@parity/product-sdk-terminal": minor
---

**Resource allocation:** export the RFC-0010 API from the package root — the cached, adapter-scoped `requestResourceAllocation`, plus a new cache-free `sendResourceAllocation(session, productId, resources, onExisting)` primitive for consumers that hold only a `productId` and manage their own policy. The `AllocatableResource`, `ApAllocationOutcome`, `OnExistingAllowancePolicy`, and `RequestResourceAllocationOptions` types (all derived from `UserSession`, so they can't drift from the host codec) are exported alongside. Lets `@parity/product-sdk-auth` delegate instead of maintaining a second hand-declared copy of the wire types and call.

**Session signer self-derivation:** `createSessionSigner` / `createSessionSignerForAccount` now soft-derive the product account's public key from the session root when `ProductAccountRef.publicKey` is omitted, instead of falling back to the wallet's *selected* account. The old fallback silently produced an invalid signature for any product account that wasn't the currently-selected one. Callers (playground-cli, bulletin-deploy, product-sdk-auth) no longer need to hand-derive and pass `publicKey`. Adds a `@parity/product-sdk-keys` dependency.
