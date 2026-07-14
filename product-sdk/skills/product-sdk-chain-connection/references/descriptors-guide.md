# Descriptors Guide

Package: `@parity/product-sdk-descriptors`

## What Are Descriptors?

Descriptors are TypeScript type definitions generated from chain metadata. They provide:

- **Type-safe queries** — Know exactly what parameters are required and what types are returned
- **Autocomplete** — IDE support for all available pallets, storage items, and calls
- **Compile-time errors** — Catch mistakes before runtime

## Installation

```bash
npm install @parity/product-sdk-descriptors polkadot-api
```

> **Important:** `polkadot-api` is a peer dependency and must be installed alongside descriptors.

## Subpath Imports

Always use subpath imports to load only the chains you need:

```typescript
// CORRECT - loads only paseo bulletin (~912 KB)
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";

// WRONG - would load all chains (not supported)
import { paseo_bulletin } from "@parity/product-sdk-descriptors";
```

## Available Chains

Every chain is namespaced by environment so `descriptor.genesis` matches the
live chain instance.

| Chain | Import Path | Export Name |
|-------|-------------|-------------|
| Polkadot Asset Hub | `@parity/product-sdk-descriptors/polkadot-asset-hub` | `polkadot_asset_hub` |
| Kusama Asset Hub | `@parity/product-sdk-descriptors/kusama-asset-hub` | `kusama_asset_hub` |
| Paseo Asset Hub | `@parity/product-sdk-descriptors/paseo-asset-hub` | `paseo_asset_hub` |
| Paseo Bulletin | `@parity/product-sdk-descriptors/paseo-bulletin` | `paseo_bulletin` |
| Paseo Individuality | `@parity/product-sdk-descriptors/paseo-individuality` | `paseo_individuality` |

## Usage with createChainClient

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";

const client = await createChainClient({
    chains: {
        assetHub: paseo_asset_hub,
        bulletin: paseo_bulletin,
    },
});

// Fully typed!
const account = await client.assetHub.query.System.Account.getValue(address);
// account.data.free is typed as bigint
```

## Type Extraction

Extract types for use in your application:

```typescript
import type { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import type { TypedApi } from "polkadot-api";

// Get the typed API type
type AssetHubApi = TypedApi<typeof paseo_asset_hub>;

// Use in function signatures
async function getBalance(api: AssetHubApi, address: string) {
    const account = await api.query.System.Account.getValue(address);
    return account.data.free;
}
```

## Regenerating Descriptors

The descriptors package uses PAPI's codegen. To regenerate after a runtime upgrade:

```bash
cd packages/descriptors
pnpm generate
pnpm build
```

This fetches fresh metadata from live chains and regenerates TypeScript types.

## Bundle Size Optimization

For production apps, only import the chains you need:

```typescript
// Minimal setup for contracts (~1.2 MB)
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
});
```

vs.

```typescript
// Full preset (~6.3 MB for all chains)
const client = await getChainAPI("paseo");
```

## Common Mistakes

1. **Barrel importing** — Don't import from `@parity/product-sdk-descriptors`. Use subpath imports.

2. **Missing polkadot-api** — It's a peer dependency. Always install it.

3. **Wrong chain for environment** — Use `paseo_asset_hub` for testnet, `polkadot_asset_hub` for mainnet.

4. **Stale descriptors** — If you see type mismatches after a runtime upgrade, regenerate descriptors.
