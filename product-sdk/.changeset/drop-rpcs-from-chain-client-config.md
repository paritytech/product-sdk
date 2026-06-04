---
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk": minor
---

**Remove the unused `rpcs` field from `ChainClientConfig`.**

`createChainClient` routed every connection through the host provider, so
the `rpcs` endpoints were never read at runtime — the field only forced
callers to construct and pass a no-op argument. It has been removed, and
`createChainClient({ chains })` is now the full config shape. The internal
preset RPC table and the dead `getChainAPI` wiring that fed it were dropped
as well.

**Breaking:** callers that passed `rpcs: {...}` will hit a TypeScript
excess-property error and must delete that key. There is no runtime behavior
change — the field carried no effect.

```diff
 const client = await createChainClient({
     chains: { assetHub: paseo_asset_hub },
-    rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
 });
```
