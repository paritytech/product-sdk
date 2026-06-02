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
check the wrapper performs internally) *before* handing a provider to PAPI. When
the host can't serve the chain, it throws the new `ChainNotSupportedError`, which
propagates out of `createChainClient` as a rejected promise. The error carries the
offending `genesisHash` for programmatic handling:

```ts
import { createChainClient, ChainNotSupportedError } from "@parity/product-sdk-chain-client";

try {
    const client = await createChainClient({ chains: { assetHub: paseo_asset_hub }, rpcs: {} });
} catch (err) {
    if (err instanceof ChainNotSupportedError) {
        // err.genesisHash — the chain the host refused
    }
}
```

`ChainNotSupportedError` is exported from both `@parity/product-sdk-host` and
`@parity/product-sdk-chain-client`. Supported chains are unaffected; connecting
outside a host container still returns `null`/throws the existing "host provider
unavailable" error.
