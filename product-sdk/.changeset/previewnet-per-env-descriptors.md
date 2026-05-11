---
"@parity/product-sdk": minor
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-bulletin": minor
"@parity/product-sdk-host": patch
---

**Add previewnet environment support and split bulletin/individuality descriptors per environment.**

Previewnet is a zombienet deployment running a Paseo runtime, replacing Paseo Next v1 as the priority test target. This release wires previewnet end-to-end across the SDK and, in the process, restructures bulletin and individuality descriptors to follow the same per-environment resolution pattern already used for asset-hub — so `descriptor.genesis` now matches the live chain instance the consumer connects to.

### What's new

- **`getChainAPI("previewnet")`** routes to the zombienet endpoints at `previewnet.substrate.dev` for asset-hub, bulletin, and people (individuality).
- **`BulletinChain.previewnet`** preset with the live previewnet bulletin genesis hash.
- **`BULLETIN_RPCS.previewnet`** in `@parity/product-sdk-host` (additive).
- **New descriptor packages**: `@parity/product-sdk-descriptors/previewnet-asset-hub`, `/paseo-bulletin`, `/previewnet-bulletin`, `/paseo-individuality`, `/previewnet-individuality`. Each embeds its own genesis hash and metadata blob.

### Breaking changes

- **`@parity/product-sdk-descriptors`**: the shared `/bulletin` and `/individuality` exports are removed. Direct BYOD consumers must migrate:
  - `@parity/product-sdk-descriptors/bulletin` → `@parity/product-sdk-descriptors/paseo-bulletin` (or `/previewnet-bulletin`)
  - `@parity/product-sdk-descriptors/individuality` → `@parity/product-sdk-descriptors/paseo-individuality` (or `/previewnet-individuality`)
  - Named exports change correspondingly: `bulletin` → `paseo_bulletin`, `individuality` → `paseo_individuality`, etc.
- **`@parity/product-sdk-chain-client`**: `PresetChains<E>` now resolves bulletin and individuality per environment. `ChainClientConfig.rpcs` requires a key for every environment the consumer supplies in `chains`. Consumers using `getChainAPI(env)` are unaffected at the call site — the typed return shape just becomes more precise.
- **`@parity/product-sdk-bulletin`**: `BulletinNetwork.descriptor` is now `typeof paseo_bulletin | typeof previewnet_bulletin` (was a single type). The existing `BulletinChain.paseo.descriptor` continues to work; callers spreading `...BulletinChain.paseo` are unaffected.

### Why split the descriptors

Bulletin and individuality run identical runtimes on paseo and previewnet today, but each environment is a separate chain deployment with its own genesis block. The previous shared-descriptor model exposed paseo's genesis hash regardless of the live chain — fine for SCALE encoding/decoding (PAPI validates runtime genesis from the live `chainHead`, not the descriptor), but misleading for any consumer using `descriptor.genesis` for chain identity (caching, telemetry, multi-chain dispatch). Per-environment descriptors keep the API surface honest and give us a clean separation point if the runtimes ever diverge.

### Endpoints wired

| Chain | URL |
|---|---|
| Previewnet Asset Hub | `wss://previewnet.substrate.dev/asset-hub` |
| Previewnet Bulletin | `wss://previewnet.substrate.dev/bulletin` |
| Previewnet Individuality (People) | `wss://previewnet.substrate.dev/people` |

Statement-store routing requires no SDK changes — endpoints flow through the host container (configured in the mobile dev app builds), not our presets.

### Side fix

The `paseo-individuality` descriptor regenerated against the live paseo people-next chain reflects the v1 → v2 redeploy: genesis is now `0xa22a2424...` (was `0xd01475...` in the stale shared descriptor). Consumers querying paseo people-next storage with the old descriptor would have seen schema-level decode mismatches against the v2 runtime.
