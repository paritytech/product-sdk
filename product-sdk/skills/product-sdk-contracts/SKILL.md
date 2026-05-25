---
name: product-sdk-contracts
description: >
  Use when interacting with smart contracts (PolkaVM/Solidity) on Asset Hub, using ContractManager
  with cdm.json manifests, createContract for ad-hoc contracts, ContractRuntime creation, or contract
  type codegen. Covers @parity/product-sdk-contracts.
---

# Product SDK Contracts

`@parity/product-sdk-contracts` provides ergonomic, fully-typed smart contract interactions on Asset Hub. It supports both Solidity contracts (via pallet-revive) and PolkaVM contracts.

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

`.query()` runs a `ReviveApi.call` dry-run on the chain — no transaction, no gas cost. Targets **best-block** by default so reads observe the same state a freshly-submitted `.tx()` sees (matching `.tx()`'s default resolution). Override per call with `{ at: "finalized" }` or a block hash, or change the runtime default via `createContractRuntimeFromClient(client, descriptor, { at })`.

```typescript
const result = await counter.getCount.query();
// result.value contains the return value
// Defaults to best-block; pass { at: "finalized" } for canonical state.
```

With options:

```typescript
const result = await counter.getCount.query({
    origin: "0x...",       // Override caller address
    at: "finalized",       // Pin the dry-run to finalized state
                           // (runtime default is "best"; pass "best" | "finalized" | block hash)
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
    at: "finalized",       // Pin the sizing dry-run to a block (default:
                           // runtime "best"). No-op when both gasLimit
                           // and storageDepositLimit are supplied.
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

## Loading cargo-pvm-contract Artifacts (without CDM)

For contracts built with `cargo pvm-contract build`, the toolchain emits two
files per contract:

```
target/<name>.release.abi.json   # Solidity-flavoured ABI
target/<name>.release.polkavm    # PolkaVM bytecode
```

Use the `./pvm` subpath to feed those artefacts into the contracts package
without going through CDM:

```typescript
import {
    parsePvmContractAbi,
    loadPvmContractAbi,
    loadPvmContractArtifacts,
} from "@parity/product-sdk-contracts/pvm";
import { createContractFromClient } from "@parity/product-sdk-contracts";

// 1. In-memory (browser-safe)
import abiJson from "./counter.release.abi.json" with { type: "json" };
const abi = parsePvmContractAbi(abiJson);

// 2. From disk (Node-only)
const abi2 = await loadPvmContractAbi("./target/counter.release.abi.json");

// 3. ABI + bytecode pair (Node-only) — useful when you also want to deploy
const { abi: abi3, bytecode } = await loadPvmContractArtifacts("./target/counter.release");

// Hand the parsed ABI straight to the existing factories
const counter = await createContractFromClient(client.raw.assetHub, "0xC472...", abi);
const { value } = await counter.get.query();
await counter.increment.tx(1n, { signer });
```

The filesystem helpers lazy-import `node:fs/promises` so the `./pvm` module
remains importable in browser builds — only the call site needs to be in Node.

## ContractRuntime Access

For advanced use cases, create a ContractRuntime directly:

```typescript
import { createContractRuntimeFromClient, createContract } from "@parity/product-sdk-contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

// `at` controls which block runtime-API dry-runs target. "best" is the
// default and aligns with the .tx() resolution default; "finalized"
// reads canonical lagged state; a `0x…` block hash pins to a historical
// block. Applies to .query() *and* the .tx() / .prepare() sizing call.
// Override per call via `QueryOptions.at` / `TxOptions.at` / `PrepareOptions.at`.
const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub, {
    at: "best",
});

const counter = createContract(runtime, "0x...", abi, { signerManager });
```

The typed-API factory `createContractRuntime(typedApi, { at })` is also exported — useful for tests where you already hold a typed API. Prefer `createContractRuntimeFromClient` on every production path.

## Common Mistakes

1. **Using `api.contracts`** — There is no `.contracts` property on chain clients. Create ContractRuntime yourself or use `ContractManager.fromClient()`.

2. **Missing signerManager for tx()** — If no signer is available, `tx()` throws `ContractSignerMissingError`.

3. **Wrong signer type** — Contract transactions need a `PolkadotSigner`. Don't confuse with `StatementSignerWithKey` (for statement-store).

4. **Forgetting await** — Both `ContractManager.fromClient()` and `createContractFromClient()` return Promises.

5. **Assuming `.query()` reads finalized state** — Dry-runs default to **best-block**, matching `.tx()`'s submission resolution. A `.query()` right after a `.tx()` will read what the just-landed transaction wrote, even before finalization. Pass `{ at: "finalized" }` (per-call) or set the runtime default to `"finalized"` if your product needs canonical lagged reads.

## Reference Files

- [Contracts API](references/contracts-api.md) - Full API surface
