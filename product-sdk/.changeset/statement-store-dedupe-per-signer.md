---
"@parity/product-sdk-statement-store": patch
---

`StatementStoreClient` no longer drops a statement from a different account on a channel it has already seen one on. The dedupe key is now (signer, channel), matching the store's own per-account channel slot; keying on the channel alone collapsed every author into one slot and silently discarded all but the highest-expiry statement. Identical content published by two accounts is therefore delivered twice, once per author. The two silent drop paths (a dedupe and an undecodable statement) now log at debug.
