# @parity/product-sdk-contracts

Typed contract interactions on Polkadot Asset Hub. Resolve deployed contracts from a `cdm.json` manifest (or directly from `cargo pvm-contract build` artefacts), get fully-typed handles for `query`, `tx`, and batched `prepare` calls — backed by `pallet-revive` via PAPI typed APIs, with viem providing the Solidity ABI codec.

## Install

```bash
pnpm add @parity/product-sdk-contracts
```

## Quick start (with cdm.json)

The `cdm.json` flow is the primary path. A `cdm.json` manifest in your project root pins each contract to an address + ABI per target chain; `ContractManager.fromClient(cdm, client, descriptor)` resolves them at runtime.

```ts
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ContractManager } from "@parity/product-sdk-contracts";
import { SignerManager } from "@parity/product-sdk-signer";
import cdmJson from "./cdm.json";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
    rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
});

const signerManager = new SignerManager();
await signerManager.connect();

const manager = ContractManager.fromClient(cdmJson, client.raw.assetHub, paseo_asset_hub, {
    signerManager,
});

// Resolve by library name — typed handle returned.
const registry = manager.getContract("@w3s/playground-registry");

// Read state
const { value } = await registry.publish.query("my-app00", "ipfs://...", 0);

// Submit a tx (uses signerManager's logged-in account)
await registry.publish.tx("my-app00", "ipfs://...", 0);
```

## `ContractManager` API

### `ContractManager.fromClient(cdmJson, client, descriptor, options?)`

Synchronous factory. Builds a `ContractRuntime` internally that wires the typed API (for extrinsics + storage) and the unsafe API (for the `ReviveApi.call` dry-run, sidesteps compat-token drift when the descriptor lags a runtime upgrade) on the same `PolkadotClient`.

| Param | Type | Notes |
| --- | --- | --- |
| `cdmJson` | `CdmJson` | Imported `cdm.json` |
| `client` | `PolkadotClient` | E.g. `client.raw.assetHub` |
| `descriptor` | `ChainDefinition` | E.g. `paseo_asset_hub` from `@parity/product-sdk-descriptors` |
| `options.signerManager?` | `SignerManager` | Resolves signer + origin from the logged-in account |
| `options.defaultOrigin?` | `SS58String` | Static fallback origin for queries |
| `options.defaultSigner?` | `PolkadotSigner` | Static fallback signer for txs |
| `options.targetHash?` | `string` | Pin to a specific target. Defaults to first target in the manifest. |

### `manager.getContract(library)`

Returns a typed `Contract<C>` handle. Each ABI method exposes:

- `.query(...args, opts?)` — read-only dry-run; returns `{ success, value, gasRequired }`
- `.tx(...args, opts?)` — sign, submit, and watch; resolves at best-block
- `.prepare(...args, opts?)` — batch-ready handle (see *Batching* below)

When codegen-generated types are present, the call is fully typed:

```ts
const registry = manager.getContract("@w3s/playground-registry");
//                                    ^ autocompletes from cdm.json
await registry.publish.tx("domain", "ipfs://cid", 0);
//             ^ method name typed
//                       ^ args typed
```

Throws `ContractNotFoundError` if the library name isn't in the manifest for the active target.

### `manager.getAddress(library)`

Returns the on-chain address. Useful for logging or display.

### `manager.setDefaults(defaults)`

Update `origin`, `signer`, or `signerManager` after construction. Only the fields you pass are updated.

## Signer / origin resolution

Order, highest wins:

1. Explicit `{ signer }` / `{ origin }` in the call options
2. `signerManager`'s currently selected account
3. Static `defaultSigner` / `defaultOrigin`
4. (Queries only) Dev fallback (Alice) for dry-run gas estimation

Throws `ContractSignerMissingError` from `.tx()` if no signer is available. `.query()` and `.prepare()` never need a signer.

## Account mapping (`pallet-revive` prerequisite)

`pallet-revive` requires every signing SS58 account to have a registered `OriginalAccount` mapping to its derived H160 before `Revive.call` extrinsics from it are accepted. Call `ensureContractAccountMapped(runtime, address, signer)` once at app boot per signing account — it's idempotent (reads `Revive.OriginalAccount` first, short-circuits with `null` if already mapped) so the worst case is one extra storage read on every boot.

```ts
import { ensureContractAccountMapped } from "@parity/product-sdk-contracts";

await ensureContractAccountMapped(manager.getRuntime(), address, signer);
// safe to call manager.getContract(...).<method>.tx({ signer }) from here
```

Without this, every fresh-account `.tx()` fails the pre-flight dry-run with `AccountNotMapped` before signing.

## Dry-run preflight

Every `.tx()` runs a `ReviveApi.call` dry-run first to size `weight_limit` / `storage_deposit_limit` and to fail fast on revert, OOG, or `AccountNotMapped` before any signing happens. Throws `ContractDryRunFailedError` (with the chain's `dispatchError`) when the dry-run reports failure — caller pays no gas on a tx the chain already rejected. Pass both `gasLimit` and `storageDepositLimit` overrides on `TxOptions` to skip the dry-run entirely.

## Batching with `.prepare()`

Use `.prepare()` to build `BatchableCall` handles consumable by `batchSubmitAndWatch` from `@parity/product-sdk-tx`. Combine multiple contract calls — or contract calls mixed with other Asset Hub transactions — into a single atomic `Utility.batch_all` extrinsic.

```ts
import { batchSubmitAndWatch } from "@parity/product-sdk-tx";

const a = registry.publish.prepare("app-one00", "ipfs://...", 0);
const b = registry.publish.prepare("app-two00", "ipfs://...", 0);

await batchSubmitAndWatch([a, b], client.raw.assetHub, signer);
```

**`.prepare()` doesn't require a signer.** The resolved origin is used purely for dry-run gas estimation; the batch submission's signer is the dispatched origin at submission time.

`PrepareOptions` accepts: `origin`, `value`, `gasLimit`, `storageDepositLimit`. Signer and submission lifecycle options (`signer`, `waitFor`, etc.) are intentionally absent — those belong to the batch submit, not the individual prepared call.

## Without cdm.json — manual path

If you don't have a `cdm.json` (or want to test against a contract not yet in your manifest), use `createContract` / `createContractFromClient` with an explicit address and ABI:

```ts
import { createContractFromClient } from "@parity/product-sdk-contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const counter = createContractFromClient(
    client.raw.assetHub,
    paseo_asset_hub,
    "0xC472...",
    counterAbi,
    { signerManager },
);

const { value } = await counter.getCount.query();
await counter.increment.tx();
```

`createContract` is the same but takes a pre-built `ContractRuntime` (from `createContractRuntime` / `createContractRuntimeFromClient`) instead of a raw `PolkadotClient` + descriptor. Use it when you want to share a single runtime across multiple contract handles or wire your own dry-run path.

For projects that build with `cargo pvm-contract` and don't want to maintain a `cdm.json`, the `@parity/product-sdk-contracts/pvm` subpath exports `parsePvmContractAbi`, `loadPvmContractAbi`, `loadPvmContractCode`, and `loadPvmContractArtifacts` — load the ABI (and bytecode for deployment) directly from the toolchain's `<name>.release.abi.json` / `<name>.release.polkavm` output.

## cdm.json schema

Top-level shape:

```jsonc
{
  "targets": {
    "<targetHash>": {
      "asset-hub": "wss://paseo-asset-hub-next-rpc.polkadot.io",
      "bulletin": "https://paseo-bulletin-next-ipfs.polkadot.io"
    }
  },
  "dependencies": {
    "<targetHash>": {
      "@org/contract-name": "latest"
    }
  },
  "contracts": {
    "<targetHash>": {
      "@org/contract-name": {
        "version": 6,
        "address": "0x4A37B123b0BA2A894cA5953f472264921d44e298",
        "abi": [ /* Solidity-compatible ABI entries */ ]
      }
    }
  }
}
```

`<targetHash>` is a 16-character hex string identifying a chain runtime + Bulletin gateway pairing. A manifest can declare multiple targets; `ContractManager` defaults to the first, or pin one via `options.targetHash`.

A real-world example: [`paritytech/playground-cli/cdm.json`](https://github.com/paritytech/playground-cli/blob/main/cdm.json).

## Type generation

`generateContractTypes(...)` (from `@parity/product-sdk-contracts/codegen`) emits a `.d.ts` that augments the package's `Contracts` interface so `manager.getContract("@org/name")` returns a fully-typed handle:

```ts
import { generateContractTypes, resolveContractTypeInputs } from "@parity/product-sdk-contracts/codegen";
import { writeFileSync } from "node:fs";

// Mix inline ABIs (from your cdm.json) and cargo-pvm-contract build artefacts.
const resolved = await resolveContractTypeInputs([
    { library: "@example/counter", abiPath: "./target/counter.release.abi.json" },
    { library: "@example/inline", abi: inlineAbi },
]);
const src = generateContractTypes(resolved);
writeFileSync(".cdm/contracts.d.ts", src);
```

Wire `.cdm/contracts.d.ts` into your `tsconfig.json`'s `include` and the next time you call `getContract("@org/name")`, the method names, parameter types, and return types come straight from the ABI.

Without codegen, `getContract()` still works — methods are accessible but untyped (`Contract<ContractDef>`).

## Errors

| Error | When |
| --- | --- |
| `ContractNotFoundError` | `getContract(name)` and `name` isn't in the manifest for the active target |
| `ContractSignerMissingError` | `.tx()` called with no signer + no signerManager + no defaultSigner |
| `ContractDryRunFailedError` | `.tx()` pre-flight `ReviveApi.call` reported failure — `dispatchError` carries the chain's encoded error (e.g. `ContractReverted`, `OutOfGas`, `AccountNotMapped`) |
| Generic | viem ABI decode failures, RPC errors, weight/storage-limit estimation failures — surface from the underlying PAPI typed API |

## Public API

```ts
// `@parity/product-sdk-contracts` (browser-safe runtime entry)
export {
    ContractManager,
    createContract,
    createContractFromClient,
    createContractRuntime,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
    ContractError,
    ContractSignerMissingError,
    ContractNotFoundError,
    ContractDryRunFailedError,
};
export type {
    ContractRuntime,
    ReviveTypedApi,
    ReviveDryRunResult,
    ReviveDryRunCall,
    CdmJson,
    CdmJsonTarget,
    CdmJsonContract,
    AbiParam,
    AbiEntry,
    Contract,
    ContractDef,
    Contracts,
    QueryResult,
    QueryOptions,
    TxOptions,
    TxResult,
    PrepareOptions,
    BatchableCall,
    ContractDefaults,
    ContractManagerOptions,
    ContractOptions,
};

// `@parity/product-sdk-contracts/codegen` (Node-only — build tooling)
export { generateContractTypes, resolveContractTypeInputs };
export type { ContractTypeInput };

// `@parity/product-sdk-contracts/pvm` (Node-only — cargo-pvm-contract artefact loaders)
export {
    parsePvmContractAbi,
    loadPvmContractAbi,
    loadPvmContractCode,
    loadPvmContractArtifacts,
};
export type { PvmContractArtifacts };
```
