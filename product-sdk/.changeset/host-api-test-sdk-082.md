---
"@parity/product-sdk": patch
---

**Bump `@parity/host-api-test-sdk` catalog to `^0.8.2`.**

Picks up [paritytech/host-api-test-sdk#19](https://github.com/paritytech/host-api-test-sdk/pull/19) (and follow-ups) which refresh `PASEO_ASSET_HUB`, `PREVIEWNET`, and `PREVIEWNET_ASSET_HUB` to their live genesis hashes and v2 RPC endpoints. Without this bump, every e2e fixture spreading `...PASEO_ASSET_HUB` was effectively connecting under a stale genesis (v1 paseo, deprecated 2026-05-20), which broke `chain-client-demo` and downstream signing demos with `Tracking stopped` / `BadProof` / `AsPgas` errors depending on the path.

### What changed in the test SDK

| Constant | Old | New |
|---|---|---|
| `PASEO_ASSET_HUB.genesisHash` | `0xd6eec261...` | `0x173cea9d...` |
| `PASEO_ASSET_HUB.rpcUrl` | `wss://sys.ibp.network/asset-hub-paseo` | `wss://paseo-asset-hub-next-rpc.polkadot.io` |
| `PREVIEWNET.genesisHash` | `0xdd51f3c2...` | `0x477dd87a...` |
| `PREVIEWNET_ASSET_HUB.genesisHash` | `0x7765f98d...` | `0x860d75a8...` |

### Consumer impact

- **No source change** in any published `@parity/product-sdk-*` package. `@parity/host-api-test-sdk` is a `devDependency` of our example demos only — consumers installing the SDK from npm don't see this bump at all.
- **Internal contributors** writing e2e specs against `wss://sys.ibp.network/asset-hub-paseo` or any v1 paseo genesis must update to the v2 equivalents. Per-fixture changes are usually a one-line override since most spread `...PASEO_ASSET_HUB`.

### Verification

`pnpm test:e2e` runs cleanly across all demos against paseo v2 with the new SDK pulled in via the catalog (no overrides). Replaces the prior local-tarball override workflow that was a stopgap while waiting for `@parity/host-api-test-sdk@0.8.x` to publish.
