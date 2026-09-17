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
});

const manager = ContractManager.fromClient(cdmJson, client.raw.assetHub, paseo_asset_hub, {
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
});

const counter = createContractFromClient(
    client.raw.assetHub,
    paseo_asset_hub,
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
// result.value contains the return value on success
// No transaction, no gas cost
// Defaults to best-block; pass { at: "finalized" } for canonical state.
```

With options:

```typescript
const result = await counter.getCount.query({
    origin: "5GrwvaEF...",  // Override caller — must be an SS58 address (see below)
    at: "finalized",        // Pin the dry-run to finalized state
                            // (runtime default is "best"; pass "best" | "finalized" | block hash)
});
```

**`origin` must be SS58, not H160.** pallet-revive derives the H160 `msg.sender`
*from* the SS58 origin, so `origin` (on `query()`, `tx()`, `prepare()`, and
`ContractDefaults`/`defaultOrigin`) is validated as SS58 before it reaches the
codec. Passing an H160 (`0x…`) throws `ContractInvalidOriginError` — convert it
first with `h160ToSs58` from `@parity/product-sdk-address`. This is a validation
error, not a silent auto-conversion, so it never hides which account you meant.

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

**`AccountNotMapped`** on `value` means the origin has no `pallet-revive`
mapping yet. To check ahead of time without a signer or a wallet prompt, use the
read-only probe `isContractAccountMapped(runtime, ss58Address)` — it returns a
`Result<boolean, ContractError>`. To create the mapping when it's missing, call
`ensureContractAccountMapped(runtime, ss58Address, signer)` (submits the mapping
extrinsic only if needed). See [Contracts API](references/contracts-api.md#account-mapping).

### tx() — State-Changing Transactions

`.tx()` returns a `Promise<Result<TxResult, ContractError | TxError>>` where
`Result<T, E>` is `{ ok: true; value: T } | { ok: false; error: E }`. It does
**not** throw — pre-submit failures (`ContractSignerMissingError`,
`ContractDryRunFailedError`, `ContractRevertedError`) and submit failures
(`TxError`) all come back on the `result.error` channel. Always check
`result.ok` before reading `result.value`.

```typescript
const result = await counter.increment.tx();
// tx() returns a Result — it does NOT throw on failure.
if (!result.ok) {
    // result.error is a ContractError (pre-submit) or TxError (submit)
    handle(result.error);
} else {
    // result.value is the TxResult: result.value.block.hash, result.value.txHash
    console.log("Included in block:", result.value.block.hash);
}
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

**Pre-flight revert detection.** Before submitting, `tx()` runs a dry-run. If
the chain reports the REVERT flag is set, `tx()` returns `err(ContractRevertedError)`
(on the `result.error` channel, NOT thrown) and the extrinsic is NOT submitted
(no gas paid). The error carries `methodName`, the raw `data`, and the same
`reason` / `decoded` fields as the query payload. Passing both `gasLimit` AND
`storageDepositLimit` in options skips the dry-run entirely — including this
revert pre-check.

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

const manager = ContractManager.fromClient(cdmJson, client.raw.assetHub, paseo_asset_hub, {
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
const manager = ContractManager.fromClient(cdmJson, client.raw.assetHub, paseo_asset_hub, {
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
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

// 1. In-memory (browser-safe)
import abiJson from "./counter.release.abi.json" with { type: "json" };
const abi = parsePvmContractAbi(abiJson);

// 2. From disk (Node-only)
const abi2 = await loadPvmContractAbi("./target/counter.release.abi.json");

// 3. ABI + bytecode pair (Node-only) — useful when you also want to deploy
const { abi: abi3, bytecode } = await loadPvmContractArtifacts("./target/counter.release");

// Hand the parsed ABI straight to the existing factories
const counter = createContractFromClient(client.raw.assetHub, paseo_asset_hub, "0xC472...", abi);
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

2. **Missing signerManager for tx()** — If no signer is available, `tx()` returns `err(ContractSignerMissingError)` (on `result.error`, not thrown). Check `!result.ok` before reading `result.value`.

3. **Wrong signer type** — Contract transactions need a `PolkadotSigner`. Don't confuse with `StatementSignerWithKey` (for statement-store).

4. **Adding a spurious `await`** — `ContractManager.fromClient()` and `createContractFromClient()` are **synchronous**; don't `await` them. Only the live-resolution factories `ContractManager.fromLive()` / `fromLiveClient()` (and `withLiveContractAddresses()`) return Promises.

5. **Assuming `tx()` only fails for signer/dispatch reasons** — `tx()` also returns `err(ContractRevertedError)` when the dry-run shows the contract would revert. Branch on `!result.ok` and inspect `result.error` (`instanceof ContractRevertedError`, or its base `ContractError`) if you're surfacing revert reasons to users. `tx()` no longer throws these — they arrive on the `result.error` channel.

6. **Assuming `query()` throws on revert** — It doesn't. Reverts come back as `{ success: false, value: { type: "ContractRevertedWithPayload", ... } }`. Always check `success` before reading `value` as the return type.

7. **Using `manager.getSigner()` (legacy account) on chains with unknown signed extensions** — `signerManager.connect()` exposes legacy accounts, whose signer routes through PJS. On chains like Paseo Next v2 that ship `AsPgas`, PJS throws `PJS does not support this signed-extension: AsPgas` at signing time. Use `signerManager.getProductAccount(<appOrigin>, 0)` and `productAccount.getSigner()` instead — that path goes through `host_create_transaction` and preserves arbitrary extensions.

8. **Assuming `.query()` reads finalized state** — Dry-runs default to **best-block**, matching `.tx()`'s submission resolution. A `.query()` right after a `.tx()` will read what the just-landed transaction wrote, even before finalization. Pass `{ at: "finalized" }` (per-call) or set the runtime default to `"finalized"` if your product needs canonical lagged reads.

9. **Passing an H160 as `origin`** — `origin` (and `defaultOrigin`) must be an **SS58** address. Passing the account's H160 (`0x…`) throws `ContractInvalidOriginError` — pallet-revive derives the H160 `msg.sender` from the SS58 origin, so convert first with `h160ToSs58` from `@parity/product-sdk-address`. It's validated, not auto-converted, so the mistake surfaces immediately instead of a bare `Invalid checksum` deep in the codec.

10. **Not checking `pallet-revive` mapping before a `tx()`** — A contract call from an unmapped account fails with `AccountNotMapped`. Probe first with `isContractAccountMapped(runtime, address)` (read-only, no signer/prompt) or create the mapping with `ensureContractAccountMapped(runtime, address, signer)`.

## Reference Files

- [Contracts API](references/contracts-api.md) - Full API surface
