---
"@parity/product-sdk-chain-client": patch
---

Correct the `createChainClient` and package-level JSDoc, which said both entry points take or bundle RPC endpoints. Neither does: `ChainClientConfig` accepts only `chains`, and the host resolves each connection from the descriptor's genesis hash. Also list `previewnet` among the live preset environments.
