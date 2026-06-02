# Chain Client API Reference

Package: `@parity/product-sdk-chain-client`

## getChainAPI

Create a chain client for a preset environment with zero configuration.

```typescript
async function getChainAPI<E extends Environment>(env: E): Promise<ChainClient<PresetChains<E>>>
```

**Parameters:**
- `env` - Environment name: `"paseo"`, `"polkadot"`, or `"kusama"`

**Returns:** A `ChainClient` with typed APIs for all chains in the environment.

**Throws:** If the environment is not yet available (only `"paseo"` is currently supported).

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

// Access typed APIs
client.assetHub.query.System.Account.getValue(address);
client.bulletin.query.TransactionStorage.BytesFee.getValue();
client.individuality.query.Identity.IdentityOf.getValue(address);

// Access raw PAPI clients
client.raw.assetHub;
client.raw.bulletin;

// Cleanup
client.destroy();
```

---

## createChainClient

Create a chain client with custom chains (BYOD path).

```typescript
async function createChainClient<C extends ChainMap>(config: ChainClientConfig<C>): Promise<ChainClient<C>>
```

**Parameters:**
- `config.chains` - Object mapping chain names to descriptors

**Returns:** A `ChainClient` with typed APIs for the specified chains.

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

// Only the specified chains are available
client.assetHub.query.System.Account.getValue(address);
client.bulletin.query.TransactionStorage.BytesFee.getValue();

client.destroy();
```

---

## destroyAll

Destroy all active chain clients. Useful for cleanup in tests.

```typescript
function destroyAll(): void
```

```typescript
import { destroyAll } from "@parity/product-sdk-chain-client";

afterAll(() => {
    destroyAll();
});
```

---

## ChainClient

The chain client interface returned by `getChainAPI` and `createChainClient`.

```typescript
interface ChainClient<C extends ChainMap> {
    // Typed APIs for each chain (e.g., client.assetHub)
    [chainName: string]: TypedApi<Descriptor>;

    // Raw PAPI clients for advanced use
    raw: {
        [chainName: string]: PolkadotClient;
    };

    // Cleanup
    destroy(): void;
}
```

### Query Methods

Each typed API provides query methods for reading chain state:

```typescript
// Get single value
const value = await client.assetHub.query.System.Number.getValue();

// Get value with arguments
const account = await client.assetHub.query.System.Account.getValue(address);

// Subscribe to changes
const unsub = client.assetHub.query.System.Account.watchValue(address, (value) => {
    console.log("Updated:", value);
});

// Get all entries in a storage map
const entries = await client.assetHub.query.System.Account.getEntries();

// Get entries with partial key
const filtered = await client.assetHub.query.Assets.Account.getEntries(assetId);
```

### Transaction Methods

Each typed API provides transaction builders:

```typescript
// Build a transaction (does not submit)
const tx = client.assetHub.tx.Balances.transferKeepAlive({
    dest: recipientAddress,
    value: 1_000_000_000_000n,
});

// Submit with @parity/product-sdk-tx
import { submitAndWatch } from "@parity/product-sdk-tx";
const result = await submitAndWatch(tx, signer, { waitFor: "finalized" });
```

### Constants

Access runtime constants:

```typescript
const existentialDeposit = client.assetHub.constants.Balances.ExistentialDeposit();
```

---

## Types

### Environment

```typescript
type Environment = "polkadot" | "kusama" | "paseo";
```

### ChainMap

```typescript
type ChainMap = Record<string, Descriptor>;
```

### ChainClientConfig

```typescript
interface ChainClientConfig<C extends ChainMap> {
    chains: C;
}
```

### PresetChains

The chains available for each preset environment:

```typescript
type PresetChains<E extends Environment> = {
    assetHub: TypedApi<AssetHubDescriptor<E>>;
    bulletin: TypedApi<BulletinDescriptor>;
    individuality: TypedApi<IndividualityDescriptor>;
};
```

---

## Re-exports

The package re-exports useful types from polkadot-api:

```typescript
export type { TypedApi, PolkadotClient } from "polkadot-api";
```
