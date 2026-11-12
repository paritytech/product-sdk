---
"@parity/product-sdk-chain-client": patch
"@parity/product-sdk-host": patch
"@parity/product-sdk": patch
---

A product holds one `chainHead_v1_follow` per chain, however many `createChainClient` configs ask for that chain. `createChainClient` keeps one shared `PolkadotClient` per genesis hash, counted by the `ChainClient`s holding it: a config that includes a chain another config already opened reuses its client, two configs starting at once on the same chain end up with one, and `destroy()` on a `ChainClient` only gives back its own hold, so the chain stays open for every other config until the last one is destroyed. `destroy()` is safe to call more than once, a config that fails to start gives back the chains it took without closing them for anyone else, `getClient` and `isConnected` look a chain up by genesis hash alone, and `client.raw.<name>` is the chain's shared client, so calling `.destroy()` on it directly closes the chain for every other user. A chain the host refuses still gets the stand-in that throws `ChainNotSupportedError` on use and holds no shared client.

Outside production builds, the host-routed PAPI provider logs an error through the SDK logger when a second connection in the same product opens a follow on a chain another connection already follows: `chain <genesis> now has <n> follows from this product: share one client per chain (createChainClient / getClient) instead of creating another.` It counts connections, not follows, so a client that follows again while recovering from a stop is never reported.
