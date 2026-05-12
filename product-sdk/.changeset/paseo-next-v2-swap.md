---
"@parity/product-sdk": minor
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-bulletin": minor
"@parity/product-sdk-host": patch
---

**Migrate the `paseo` preset to Paseo Next v2 endpoints and chain instances.**

Paseo Next v1 is being shut down on 2026-05-20. Per the Paseo team, v2 is the successor — not a parallel network — so the `"paseo"` preset string keeps its name and now points at v2 chains. Consumers calling `getChainAPI("paseo")` get v2 with no code change.

### What changed

- **`@parity/product-sdk-chain-client`**: `rpcs.paseo` swaps to the new endpoints (asset-hub-next, bulletin-next, people-next-system). The retired v1 mirrors (`sys.ibp.network/asset-hub-paseo`, `asset-hub-paseo-rpc.n.dwellir.com`, `paseo-bulletin-rpc.polkadot.io`, `paseo-people-next-rpc.polkadot.io`) are gone.
- **`@parity/product-sdk-descriptors`**: every paseo subpackage (`paseo-asset-hub`, `paseo-bulletin`, `paseo-individuality`) regenerated against the live v2 RPC. Each descriptor's embedded `genesis` and `codeHash` reflect the v2 chain instance.
- **`@parity/product-sdk-bulletin`**: `BulletinChain.paseo.genesisHash` literal updated to the v2 bulletin genesis.
- **`@parity/product-sdk-host`**: `BULLETIN_RPCS.paseo` updated; `DEFAULT_BULLETIN_ENDPOINT` follows since it's `BULLETIN_RPCS.paseo[0]`.

### New endpoints

| Chain | URL | Genesis |
|---|---|---|
| Asset Hub Next (1500) | `wss://paseo-asset-hub-next-rpc.polkadot.io` | `0x173cea9df45656cf612c8b8ece56e04e9a693c69cfaac47d3628dae735067af8` |
| Bulletin Next (1501) | `wss://paseo-bulletin-next-rpc.polkadot.io` | `0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22` |
| People Next System (1502) | `wss://paseo-people-next-system-rpc.polkadot.io` | `0x053e1a785bb0990b98768124d9609e963d9ca3558f5ac6e90a4297aaa0a0bd4b` |

### Breaking changes

- Consumers that hardcoded any of the retired v1 RPC URLs must update them.
- Consumers comparing genesis hashes (e.g. for chain-identity cache keys) will see different values for paseo asset-hub, bulletin, and individuality. The `paseo_asset_hub`, `paseo_bulletin`, and `paseo_individuality` descriptor objects each carry a new `.genesis` value, and `BulletinChain.paseo.genesisHash` is updated.
- The `paseo-asset-hub` descriptor config switched from polkadot-api chain-spec resolution (`"chain": "paseo_asset_hub"`) to `wsUrl`-based resolution, since the chain spec registry doesn't yet know about v2. No consumer-visible impact — the resulting descriptor module exports the same `paseo_asset_hub` symbol with the same shape.
