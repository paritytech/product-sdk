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

```typescript
const result = await counter.getCount.query();
// result.value contains the return value on success
// No transaction, no gas cost
```

With options:

```typescript
const result = await counter.getCount.query({
    origin: "0x...",  // Override caller address
});
```

**Reverts.** `query()` does NOT throw on a contract revert — it returns
`{ success: false, value, gasRequired }`. Two failure shapes are possible:

- Dispatch-level failures from the chain (e.g. `{ type: "ContractReverted" }`,
  `{ type: "AccountNotMapped" }`, `{ type: "Module", ... }`) — passed through
  on `value` as-is.
- Contract-level reverts (REVERT flag set on a dispatched-OK call) — surfaced
  as a tagged payload: `{ type: "ContractRevertedWithPayload", data, reason?, decoded? }`.
  `reason` is the decoded `Error(string)` message or a mapped `Panic` description;
  `decoded` carries the viem-decoded `{ errorName, args }` for ABI-defined custom
  errors. Discriminate on `value.type` to tell the two failure paths apart.

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

**Pre-flight revert detection.** Before submitting, `tx()` runs a dry-run. If
the chain reports the REVERT flag is set, `tx()` throws `ContractRevertedError`
and the extrinsic is NOT submitted (no gas paid). The error carries `methodName`,
the raw `data`, and the same `reason` / `decoded` fields as the query payload.
Passing both `gasLimit` AND `storageDepositLimit` in options skips the dry-run
entirely — including this revert pre-check.

## SignerManager Integration

Pass a `SignerManager` and a **product-account signer** to sign contract `tx()` calls:

```typescript
import { SignerManager } from "@parity/product-sdk-signer";

const signerManager = new SignerManager({ ss58Prefix: 0, dappName: "your-app" });

// Establish the host session.
await signerManager.connect();

// Request a product account — its signer routes through
// `host_create_transaction` (PR #96), which preserves arbitrary signed
// extensions (e.g. `AsPgas` on Paseo Next v2). Required on any chain that
// ships signed extensions PJS doesn't know about.
const productRes = await signerManager.getProductAccount("your-app.dot", 0);
if (!productRes.ok) throw productRes.error;
const productAccount = productRes.value;

const manager = await ContractManager.fromClient(cdmJson, client.raw.assetHub, {
    signerManager,
});

// All tx() calls sign via the product account's `host_create_transaction` path.
await counter.increment.tx({ signer: productAccount.getSigner() });
```

See [`examples/tx-demo/src/main.ts`](../../examples/tx-demo/src/main.ts) and
[`examples/contracts-demo/src/main.ts`](../../examples/contracts-demo/src/main.ts)
for full end-to-end references.

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

For advanced use cases, create an ContractRuntime directly:

```typescript
import { createContractRuntime } from "@parity/product-sdk-contracts";

const runtime = createContractRuntime(client.raw.assetHub, { atBest: true });

// Use with createContract
import { createContract } from "@parity/product-sdk-contracts";
const counter = createContract(runtime, "0x...", abi, { signerManager });
```

## Common Mistakes

1. **Using `api.contracts`** — There is no `.contracts` property on chain clients. Create ContractRuntime yourself or use `ContractManager.fromClient()`.

2. **Missing signerManager for tx()** — If no signer is available, `tx()` throws `ContractSignerMissingError`.

3. **Wrong signer type** — Contract transactions need a `PolkadotSigner`. Don't confuse with `StatementSignerWithKey` (for statement-store).

4. **Forgetting await** — Both `ContractManager.fromClient()` and `createContractFromClient()` return Promises.

5. **Assuming `tx()` only fails for signer/dispatch reasons** — `tx()` also throws `ContractRevertedError` when the dry-run shows the contract would revert. Catch it (or its base `ContractError`) if you're surfacing revert reasons to users.

6. **Assuming `query()` throws on revert** — It doesn't. Reverts come back as `{ success: false, value: { type: "ContractRevertedWithPayload", ... } }`. Always check `success` before reading `value` as the return type.

7. **Using `manager.getSigner()` (legacy account) on chains with unknown signed extensions** — `signerManager.connect()` exposes legacy accounts, whose signer routes through PJS. On chains like Paseo Next v2 that ship `AsPgas`, PJS throws `PJS does not support this signed-extension: AsPgas` at signing time. Use `signerManager.getProductAccount(<appOrigin>, 0)` and `productAccount.getSigner()` instead — that path goes through `host_create_transaction` and preserves arbitrary extensions.

## Reference Files

- [Contracts API](references/contracts-api.md) - Full API surface
