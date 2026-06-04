---
"@parity/product-sdk-host": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk": minor
---

**Surface a catchable error when the host doesn't support a chain, instead of hanging forever.**

Previously, connecting to a chain the host doesn't recognize (e.g. not enabled
in the current Desktop/Browser build, or a descriptor genesis hash that drifted
after a network reset) produced a provider whose JSON-RPC requests were silently
dropped. Every query against that chain then awaited indefinitely — no rejection,
no error, no built-in timeout.

`getHostProvider` now verifies host support (via the same `host_feature_supported`
check the wrapper performs internally) *before* handing a provider to PAPI, and
throws the new `ChainNotSupportedError` (carrying the offending `genesisHash`) when
the host can't serve the chain.

`createChainClient` degrades per-chain rather than all-or-nothing: supported chains
in the same call stay fully usable, and an unsupported chain's API throws
`ChainNotSupportedError` on first use (e.g. `client.assetHub.query…`) instead of
hanging. This matches the reported behaviour where one chain (Bulletin) keeps
working while another is unavailable. A hard failure (e.g. not running inside a
container) still rejects the whole call as before.

```ts
import { createChainClient, ChainNotSupportedError } from "@parity/product-sdk-chain-client";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
});

try {
    await client.assetHub.query.System.Number.getValue();
} catch (err) {
    if (err instanceof ChainNotSupportedError) {
        // err.genesisHash — the chain the host refused
    }
}

// Other chains in the same client are unaffected:
await client.bulletin.query.TransactionStorage.ByteFee.getValue();
```

`ChainNotSupportedError` is exported from both `@parity/product-sdk-host` and
`@parity/product-sdk-chain-client`. Connecting outside a host container still
returns `null` / throws the existing "host provider unavailable" error.
