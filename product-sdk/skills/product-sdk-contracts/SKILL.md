---
name: product-sdk-contracts
description: >
  Use when interacting with smart contracts (Solidity/ink!) on Asset Hub, using ContractManager
  with cdm.json manifests, createContract for ad-hoc contracts, InkSdk creation, or contract
  type codegen. Covers @parity/product-sdk-contracts.
---

# Product SDK Contracts

`@parity/product-sdk-contracts` provides ergonomic, fully-typed smart contract interactions on Asset Hub. It supports both Solidity contracts (via pallet-revive) and ink! contracts.

## Quick Start: With cdm.json Manifest

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ContractManager } from "@parity/product-sdk-contracts";
import cdmJson from "./cdm.json";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
    rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
});

const manager = await ContractManager.fromClient(cdmJson, client.raw.assetHub, {
    signerManager, // from @parity/product-sdk-signer
});

// Get a typed contract handle
const counter = manager.getContract("@example/counter");

// Read state
const { value } = await counter.getCount.query();
console.log("Count:", value);

// Write state
await counter.increment.tx();

client.destroy();
```

## Quick Start: Ad-Hoc Contract

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { createContractFromClient } from "@parity/product-sdk-contracts";

const abi = [
    { type: "function", name: "getCount", inputs: [], outputs: [{ name: "", type: "uint32" }], stateMutability: "view" },
    { type: "function", name: "increment", inputs: [], outputs: [], stateMutability: "nonpayable" },
];

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
    rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
});

const counter = await createContractFromClient(
    client.raw.assetHub,
    "0xYourContractAddress...",
    abi,
    { signerManager }
);

const { value } = await counter.getCount.query();
await counter.increment.tx();

client.destroy();
```

## ContractManager vs createContract

| | `ContractManager` | `createContract` / `createContractFromClient` |
|---|---|---|
| **When** | Multiple contracts with cdm.json manifest | Single contract, known address + ABI |
| **Type safety** | Full (with codegen) | Generic |
| **Address management** | Automatic from manifest | You provide it |
| **Use case** | Production dApps | Quick prototyping, ad-hoc contracts |

## Contract Methods

Each method on a contract handle has two variants:

### query() — Read-Only Calls

```typescript
const result = await counter.getCount.query();
// result.value contains the return value
// No transaction, no gas cost
```

With options:

```typescript
const result = await counter.getCount.query({
    origin: "0x...",  // Override caller address
});
```

### tx() — State-Changing Transactions

```typescript
const result = await counter.increment.tx();
// Submits a transaction, waits for inclusion
// result.blockHash contains the block hash
```

With options:

```typescript
const result = await counter.increment.tx({
    signer: customSigner,  // Override the default signer
    waitFor: "finalized",  // Wait for finality (default: "best-block")
    onStatus: (status) => console.log(status),
});
```

## SignerManager Integration

Pass a `SignerManager` to automatically use the connected wallet account:

```typescript
import { SignerManager } from "@parity/product-sdk-signer";

const signerManager = new SignerManager();
await signerManager.connect();

const manager = await ContractManager.fromClient(cdmJson, client.raw.assetHub, {
    signerManager,
});

// All tx() calls use the connected account automatically
await counter.increment.tx();
```

You can also set a default signer or origin:

```typescript
const manager = await ContractManager.fromClient(cdmJson, client.raw.assetHub, {
    defaultSigner: mySigner,
    defaultOrigin: "0x...",
});

// Update defaults later
manager.setDefaults({
    signerManager: newSignerManager,
});
```

## Type Codegen

Generate TypeScript types for your contracts:

```typescript
import { generateContractTypes } from "@parity/product-sdk-contracts";
import { writeFileSync } from "fs";

const types = generateContractTypes([
    { library: "@example/counter", abi: counterAbi },
    { library: "@example/token", abi: tokenAbi },
]);

writeFileSync(".cdm/contracts.d.ts", types);
```

This generates a module augmentation that makes `getContract()` return fully-typed handles:

```typescript
// After codegen
const counter = manager.getContract("@example/counter");
// counter.getCount is typed with correct args and return type
```

## InkSdk Access

For advanced use cases, create an InkSdk directly:

```typescript
import { createInkSdk } from "@polkadot-api/sdk-ink";

const inkSdk = createInkSdk(client.raw.assetHub, { atBest: true });

// Use with createContract
import { createContract } from "@parity/product-sdk-contracts";
const counter = createContract(inkSdk, "0x...", abi, { signerManager });
```

## Common Mistakes

1. **Using `api.contracts`** — There is no `.contracts` property on chain clients. Create InkSdk yourself or use `ContractManager.fromClient()`.

2. **Missing signerManager for tx()** — If no signer is available, `tx()` throws `ContractSignerMissingError`.

3. **Wrong signer type** — Contract transactions need a `PolkadotSigner`. Don't confuse with `StatementSignerWithKey` (for statement-store).

4. **Forgetting await** — Both `ContractManager.fromClient()` and `createContractFromClient()` return Promises.

## Reference Files

- [Contracts API](references/contracts-api.md) - Full API surface
