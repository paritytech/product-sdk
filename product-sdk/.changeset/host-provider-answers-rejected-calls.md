---
"@parity/product-sdk-host": patch
"@parity/product-sdk": patch
---

A host call that rejects now answers PAPI with a JSON-RPC error. truapi
rejects a call on a timeout, a closed transport or an abort, and the chain
provider answered only from the two arms of `.match`, which a rejection never
reaches. A timed-out `chainHead_v1_storage`, `chainHead_v1_call` or
`chainHead_v1_unpin` therefore stayed unsettled for good, and a best-block
watch that waited on it stopped with no error.

The provider now answers through the new `matchHostResult`, which runs on the
same `matchGuarded` path as `unwrapHostResult` and `mapHostResult`. A
rejection reaches the error arm as a `HostResponseDecodeError`.
