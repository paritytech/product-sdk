# Chains Reference

## Environments

The SDK supports three environments, each with its own set of chains:

| Environment | Status | Asset Hub | Bulletin | Individuality |
|-------------|--------|-----------|----------|---------------|
| **paseo** (testnet) | Available | Yes | Yes | Yes |
| polkadot (mainnet) | Planned | Planned | Planned | Planned |
| kusama (canary) | Planned | Planned | Planned | Planned |

> **WARNING:** Only the `"paseo"` environment is currently available. Using `"polkadot"` or `"kusama"` will throw an error.

## Chain Properties

### Paseo Asset Hub

- **Chain ID**: `paseo_asset_hub`
- **Token**: PAS (testnet DOT)
- **Decimals**: 10
- **RPC**: `wss://paseo-asset-hub-next-rpc.polkadot.io`
- **Features**: Native balances, assets, NFTs, smart contracts (pallet-revive)

### Paseo Bulletin

- **Chain ID**: `paseo_bulletin`
- **Token**: None (no native token)
- **RPC**: `wss://paseo-bulletin-next-rpc.polkadot.io`
- **Features**: Decentralized data storage, CID-based content addressing

### Paseo Individuality

- **Chain ID**: `paseo_individuality`
- **Token**: None (no native token)
- **RPC**: `wss://paseo-people-next-system-rpc.polkadot.io`
- **Features**: Identity, personhood verification

## Descriptor Imports

### Preset Path (via getChainAPI)

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

// All descriptors loaded automatically for the environment
const client = await getChainAPI("paseo");
// client.assetHub, client.bulletin, client.individuality available
```

### BYOD Path (selective imports)

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";

// Only import what you need
const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
});
```

## Available Descriptor Packages

| Chain | Import Path | Bundle Size |
|-------|-------------|-------------|
| Paseo Asset Hub | `@parity/product-sdk-descriptors/paseo-asset-hub` | ~1.2 MB |
| Polkadot Asset Hub | `@parity/product-sdk-descriptors/polkadot-asset-hub` | ~1.2 MB |
| Kusama Asset Hub | `@parity/product-sdk-descriptors/kusama-asset-hub` | ~1.2 MB |
| Paseo Bulletin | `@parity/product-sdk-descriptors/paseo-bulletin` | ~912 KB |
| Paseo Individuality | `@parity/product-sdk-descriptors/paseo-individuality` | ~800 KB |

Each descriptor pins `descriptor.genesis` to the live chain instance it
targets.

## SS58 Prefixes

| Network | Prefix | Example |
|---------|--------|---------|
| Generic Substrate | 42 | `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY` |
| Polkadot | 0 | `15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5` |
| Kusama | 2 | `HNZata7iMYWmk5RvZRTiAsSDhV8366zq2YGb3tLH5Upf74F` |

Use `@parity/product-sdk-address` to convert between formats:

```typescript
import { normalizeSs58 } from "@parity/product-sdk-address";

const polkadotAddr = normalizeSs58(genericAddr, 0);
```
