---
"@parity/product-sdk-contracts": patch
---

Document the descriptor/client pairing precondition on `createContractRuntimeFromClient`. The descriptor is a type-only token with no runtime handle, so a descriptor for a different chain than the client is connected to cannot be caught at the cast and surfaces later as a cryptic call failure. The `@param` now states the caller must pass the descriptor whose genesis matches the client's chain, and the unavoidable cast carries a comment explaining why no runtime guard is possible here. Documentation only; no runtime change.
