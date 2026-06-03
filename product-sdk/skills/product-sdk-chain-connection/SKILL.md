---
name: product-sdk-chain-connection
description: >
  Use when connecting to Polkadot chains, querying chain state, subscribing to
  storage, working with typed APIs, or choosing between preset and BYOD paths.
  Covers @parity/product-sdk-chain-client and @parity/product-sdk-descriptors.
---

# Product SDK Chain Connection

`@parity/product-sdk-chain-client` provides typed access to Polkadot parachains via polkadot-api (PAPI). It offers two paths: **preset** (zero-config for known environments) and **BYOD** (bring your own descriptors for custom setups).

## Quick Start: Preset Path

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

// Query balance
const account = await client.assetHub.query.System.Account.getValue(
    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
);
console.log("Free balance:", account.data.free);

// Clean up
client.destroy();
```

## Quick Start: BYOD Path

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
});

const account = await client.assetHub.query.System.Account.getValue(
    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
);

client.destroy();
```

## Preset vs BYOD

| | `getChainAPI` (Preset) | `createChainClient` (BYOD) |
|---|---|---|
| **When** | Known environments (paseo, polkadot, kusama) | Custom chains or a subset of chains |
| **Descriptors** | Built-in, lazy-loaded | You import and provide them |
| **Chains** | Always assetHub + bulletin + individuality | Any combination you choose |
| **Bundle size** | Slightly larger (~6.3 MB for all 3 chains) | Minimal (only what you import) |

**Use `getChainAPI`** when you want zero-config connection to a standard environment.

**Use `createChainClient`** when you need:
- Only one chain (e.g., just Asset Hub for contracts)
- Chains not in the preset list
- Minimal bundle size

## Querying Chain State

### Single Value

```typescript
// Get current block number
const blockNumber = await client.assetHub.query.System.Number.getValue();

// Get account info
const account = await client.assetHub.query.System.Account.getValue(address);
```

### With Arguments

```typescript
// Get specific asset balance
const balance = await client.assetHub.query.Assets.Account.getValue(
    assetId,
    address
);
```

### Subscriptions

```typescript
// Subscribe to balance changes
const unsubscribe = client.assetHub.query.System.Account.watchValue(
    address,
    (account) => {
        console.log("Balance changed:", account.data.free);
    }
);

// Later: stop subscription
unsubscribe();
```

### Multiple Entries

```typescript
// Get all entries in a storage map
const entries = await client.assetHub.query.System.Account.getEntries();
for (const [key, value] of entries) {
    console.log(key, value.data.free);
}
```

## Raw API Access

For advanced use cases (like creating ContractRuntime for contracts), access the raw PAPI client:

```typescript
import { createContractRuntime } from "@parity/product-sdk-contracts";

const runtime = createContractRuntime(client.raw.assetHub, { atBest: true });
```

## Environment Support

> **WARNING:** Only the `"paseo"` environment is currently available. Using `"polkadot"` or `"kusama"` will throw an error.

| Environment | Asset Hub | Bulletin | Individuality |
|-------------|-----------|----------|---------------|
| **paseo** (testnet) | Yes | Yes | Yes |
| polkadot (mainnet) | Planned | Planned | Planned |
| kusama (canary) | Planned | Planned | Planned |

## Cleanup

Always destroy clients when done to close WebSocket connections:

```typescript
// Single client
client.destroy();

// All clients (useful in tests)
import { destroyAll } from "@parity/product-sdk-chain-client";
destroyAll();
```

## Common Mistakes

1. **Forgetting `await`** — `getChainAPI()` and `createChainClient()` return Promises.

2. **Using unavailable environments** — Only `"paseo"` works. `"polkadot"` and `"kusama"` throw.

3. **Not cleaning up** — Call `client.destroy()` when done to close WebSocket connections.

4. **Barrel importing descriptors** — Use subpath imports: `@parity/product-sdk-descriptors/paseo-bulletin`, NOT `@parity/product-sdk-descriptors`.

5. **Missing polkadot-api** — It's a peer dependency. Always install it alongside chain-client.

## Reference Files

- [Chain Client API](references/chain-client-api.md) - Full API surface
- [Descriptors Guide](references/descriptors-guide.md) - Working with chain descriptors
- [Examples](references/examples.md) - Common usage patterns
