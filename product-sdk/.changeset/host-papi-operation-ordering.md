---
"@parity/product-sdk-host": patch
---

**Preserve chain-head operation ordering over TrUAPI.**

TrUAPI request responses and follow-subscription events travel independently, so a fast body, call, or storage operation can finish before its `Started(operationId)` response reaches the PAPI bridge. The host provider now buffers those early operation events by follow subscription and operation id, emits the JSON-RPC start response first, and then replays the events in arrival order. Buffers are released when the operation, follow subscription, or provider closes. This prevents PAPI from dropping an early completion and waiting indefinitely. No public API changes or consumer migration are required.
