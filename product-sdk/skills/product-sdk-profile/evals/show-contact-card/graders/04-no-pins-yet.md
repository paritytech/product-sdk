---
type: llm
focus: trace
weight: 1
---

The returned card data has no pinned NFTs, and the response tells the user that a profile carries no pinned NFTs yet (index 2 is reserved with no payload defined). It fails only if the module reads NFTs out of the profile (decoding `unknown` entries at index 2, or a `nfts` field) or calls a pin API that does not exist. Mentioning the old test shape on Paseo as background is fine
