# Chain Connection Examples

## Query Account Balance

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { formatBalance } from "@parity/product-sdk-utils";

const client = await getChainAPI("paseo");

const account = await client.assetHub.query.System.Account.getValue(
    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
);

console.log("Free:", formatBalance(account.data.free, { symbol: "DOT" }));
console.log("Reserved:", formatBalance(account.data.reserved, { symbol: "DOT" }));

client.destroy();
```

## Subscribe to Balance Changes

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

const unsubscribe = client.assetHub.query.System.Account.watchValue(
    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    (account) => {
        console.log("Balance updated:", account.data.free);
    }
);

// Stop subscription after 60 seconds
setTimeout(() => {
    unsubscribe();
    client.destroy();
}, 60_000);
```

## Query Multiple Accounts

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

const addresses = [
    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
];

const balances = await Promise.all(
    addresses.map(async (addr) => {
        const account = await client.assetHub.query.System.Account.getValue(addr);
        return { address: addr, free: account.data.free };
    })
);

console.log(balances);

client.destroy();
```

## Get All Storage Entries

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

// Get all accounts (warning: can be large on mainnet!)
const entries = await client.assetHub.query.System.Account.getEntries();

for (const [key, value] of entries) {
    console.log(`${key}: ${value.data.free}`);
}

client.destroy();
```

## Query Asset Balances

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

const assetId = 1984; // USDT on Asset Hub
const address = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const balance = await client.assetHub.query.Assets.Account.getValue(assetId, address);

if (balance) {
    console.log("Asset balance:", balance.balance);
} else {
    console.log("No balance for this asset");
}

client.destroy();
```

## Read Constants

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

const existentialDeposit = client.assetHub.constants.Balances.ExistentialDeposit();
console.log("Existential deposit:", existentialDeposit);

const blockWeights = client.assetHub.constants.System.BlockWeights();
console.log("Max block weight:", blockWeights.maxBlock);

client.destroy();
```

## BYOD with Custom Descriptors

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
});

const block = await client.assetHub.query.System.Number.getValue();
console.log("Current block:", block);

client.destroy();
```

## Access Raw PAPI Client

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");

// Access the raw PolkadotClient for advanced operations
const rawClient = client.raw.assetHub;

// Example: get finalized block hash
const finalizedHead = await rawClient.getFinalizedBlock();
console.log("Finalized block:", finalizedHead.hash);

client.destroy();
```

## Create ContractRuntime for Contracts

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { createContractRuntime } from "@parity/product-sdk-contracts";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
});

// Create ContractRuntime from raw client
const runtime = createContractRuntime(client.raw.assetHub, { atBest: true });

// Use with @parity/product-sdk-contracts
// const contract = createContract(runtime, address, abi);

client.destroy();
```

## Multiple Chains in One Client

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";

const client = await createChainClient({
    chains: {
        assetHub: paseo_asset_hub,
        bulletin: paseo_bulletin,
        individuality: paseo_individuality,
    },
});

// Query different chains
const assetHubBlock = await client.assetHub.query.System.Number.getValue();
const bulletinFee = await client.bulletin.query.TransactionStorage.BytesFee.getValue();

console.log("Asset Hub block:", assetHubBlock);
console.log("Bulletin bytes fee:", bulletinFee);

client.destroy();
```
