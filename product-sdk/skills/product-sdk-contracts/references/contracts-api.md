# Contracts API Reference

Package: `@parity/product-sdk-contracts`

## ContractManager

Manages typed contract interactions backed by a `cdm.json` manifest.

### Constructor

```typescript
new ContractManager(cdmJson: CdmJson, runtime: ContractRuntime, options?: ContractManagerOptions)
```

**Parameters:**
- `cdmJson` - The CDM manifest object
- `runtime` - An ContractRuntime instance from `@parity/product-sdk-contracts`
- `options` - Optional configuration

### Static Methods

#### fromClient

Create a ContractManager from a raw `PolkadotClient`. Convenience factory that creates the ContractRuntime internally.

```typescript
static fromClient<TDescriptor>(
    cdmJson: CdmJson,
    client: PolkadotClient,
    descriptor: TDescriptor,
    options?: ContractManagerOptions & ContractRuntimeOptions,
): ContractManager
```

```typescript
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const manager = ContractManager.fromClient(cdmJson, client.raw.assetHub, paseo_asset_hub, {
    signerManager,
    at: "best", // optional; ContractRuntimeOptions, see createContractRuntimeFromClient
});
```

#### fromLive / fromLiveClient

**Async.** Resolve each installed contract's address from the live CDM registry before constructing the manager, instead of trusting the address baked into `cdm.json`. ABIs and versions still come from the installed snapshot — only addresses are refreshed. Strict: returns `err(ContractLiveAddressResolutionError)` if an address can't be resolved (never falls back to the snapshot).

```typescript
static fromLive(
    cdmJson: CdmJson,
    runtime: ContractRuntime,
    options?: ContractManagerOptions & LiveContractResolutionOptions,
): Promise<Result<ContractManager, ContractError>>

static fromLiveClient<TDescriptor>(
    cdmJson: CdmJson,
    client: PolkadotClient,
    descriptor: TDescriptor,
    options?: ContractManagerOptions & ContractRuntimeOptions & LiveContractResolutionOptions,
): Promise<Result<ContractManager, ContractError>>
```

```typescript
const result = await ContractManager.fromLiveClient(
    cdmJson,
    client.raw.assetHub,
    paseo_asset_hub,
    { signerManager }, // registryAddress defaults to cdmJson.registry
);
if (!result.ok) throw result.error; // ContractLiveAddressResolutionError
const manager = result.value;
```

### Instance Methods

#### getContract

Get a typed contract handle.

```typescript
getContract<K extends string & keyof Contracts>(library: K): Contract<Contracts[K]>
getContract(library: string): Contract<ContractDef>
```

```typescript
const counter = manager.getContract("@example/counter");
```

#### getAddress

Get the on-chain address of an installed contract.

```typescript
getAddress(library: string): HexString
```

```typescript
const address = manager.getAddress("@example/counter");
```

#### setDefaults

Update default origin, signer, or signerManager.

```typescript
setDefaults(defaults: ContractDefaults): void
```

```typescript
manager.setDefaults({
    signerManager: newSignerManager,
    origin: "5GrwvaEF...", // SS58 — an H160 throws ContractInvalidOriginError
});
```

---

## createContract

Create a contract handle from a raw address and ABI — no `cdm.json` needed.

```typescript
function createContract(
    runtime: ContractRuntime,
    address: HexString,
    abi: AbiEntry[],
    options?: ContractOptions,
): Contract<ContractDef>
```

```typescript
import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub, {
    at: "best", // default; "best" | "finalized" | block hash. Applies to
                // .query() and the .tx() / .prepare() sizing dry-run.
});
const counter = createContract(runtime, "0xC472...", abi, {
    signerManager,
});
```

`createContractRuntime(typedApi, { at })` is also exported for tests where the caller already holds a typed API; prefer `createContractRuntimeFromClient` on production paths.

---

## createContractFromClient

Create a contract handle from a raw `PolkadotClient`, address, and ABI. Convenience wrapper that creates the ContractRuntime internally.

```typescript
function createContractFromClient<TDescriptor>(
    client: PolkadotClient,
    descriptor: TDescriptor,
    address: HexString,
    abi: AbiEntry[],
    options?: ContractOptions & ContractRuntimeOptions,
): Contract<ContractDef>
```

```typescript
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const counter = createContractFromClient(
    client.raw.assetHub,
    paseo_asset_hub,
    "0xC472...",
    abi,
    { signerManager },
);
```

---

## withLiveContractAddresses

Standalone helper behind `ContractManager.fromLive`. On success returns a **cloned** `cdm.json` whose installed contract addresses have been replaced with live addresses from the CDM registry. The input manifest is never mutated. Strict — returns `err(ContractLiveAddressResolutionError)` if any requested address can't be resolved.

```typescript
function withLiveContractAddresses(
    cdmJson: CdmJson,
    runtime: ContractRuntime,
    options?: LiveContractResolutionOptions,
): Promise<Result<CdmJson, ContractError>>
```

```typescript
const result = await withLiveContractAddresses(cdmJson, runtime, {
    libraries: ["@example/counter"], // optional subset; defaults to all
});
if (!result.ok) throw result.error; // ContractLiveAddressResolutionError
const manager = new ContractManager(result.value, runtime);
```

---

## generateContractTypes

Generate a TypeScript module augmentation for typed contract handles.

```typescript
function generateContractTypes(
    contracts: { library: string; abi: AbiEntry[] }[]
): string
```

```typescript
const types = generateContractTypes([
    { library: "@example/counter", abi: counterAbi },
]);

// Write to .cdm/contracts.d.ts
```

Output example:

```typescript
// Auto-generated by cdm install — do not edit
import type { HexString, Binary, FixedSizeBinary } from "polkadot-api";

declare module "@parity/product-sdk-contracts" {
    interface Contracts {
        "@example/counter": {
            methods: {
                getCount: { args: []; response: number };
                increment: { args: []; response: undefined };
            };
        };
    }
}
```

---

## Account mapping

A `pallet-revive` contract call fails with `AccountNotMapped` if the caller's
account has no H160 mapping yet. Two helpers, both taking a
`ContractRuntime` (from `createContractRuntime` / `createContractRuntimeFromClient`):

### isContractAccountMapped

Read-only probe — no signer, never submits a transaction or prompts a wallet.
Use it for readiness checks from side-effect-free paths.

```typescript
function isContractAccountMapped(
    runtime: ContractRuntime,
    address: SS58String,
): Promise<Result<boolean, ContractError>>
```

Returns `ok(true)` when the mapping exists, `ok(false)` when it doesn't, or
`err(ContractError)` when the address can't be converted or the storage query
fails (underlying error attached as `cause`).

```typescript
const mapped = await isContractAccountMapped(runtime, account.address);
if (mapped.ok && !mapped.value) {
    // account needs mapping before it can call contracts
}
```

### ensureContractAccountMapped

The write half: submits the mapping extrinsic only when `isContractAccountMapped`
reports the account is unmapped.

```typescript
function ensureContractAccountMapped(
    runtime: ContractRuntime,
    address: SS58String,
    signer: PolkadotSigner,
    options?: { timeoutMs?: number; onStatus?: (s: string) => void },
): Promise<Result<TxResult | null, TxError>>
```

Returns `ok(TxResult)` from the mapping extrinsic, `ok(null)` if already mapped,
or `err(TxError)` on failure.

```typescript
const result = await ensureContractAccountMapped(runtime, account.address, signer);
if (!result.ok) throw result.error;
// now safe to call contract.<method>.tx({ signer })
```

---

## Error Classes

### ContractError

Base class for all contract errors.

```typescript
class ContractError extends Error
```

### ContractSignerMissingError

Thrown when `tx()` is called without a signer available.

```typescript
class ContractSignerMissingError extends ContractError
```

### ContractNotFoundError

Thrown when `getContract()` is called with an unknown library name.

```typescript
class ContractNotFoundError extends ContractError {
    constructor(library: string)
}
```

### ContractLiveAddressResolutionError

Thrown by `ContractManager.fromLive` / `fromLiveClient` / `withLiveContractAddresses` when a live registry address can't be resolved (no `registry` configured, the contract isn't registered, or the registry query failed).

```typescript
class ContractLiveAddressResolutionError extends ContractError {
    readonly library: string | undefined;
    readonly detail: unknown;
    constructor(message: string, options?: { library?: string; detail?: unknown; cause?: unknown })
}
```

### ContractInvalidOriginError

Thrown when an `origin` (or `defaultOrigin`) passed to `query()`, `tx()`,
`prepare()`, or a manager/contract factory is not a valid SS58 address.
Raised *before* the value reaches PAPI's `AccountId` codec (which would
otherwise fail deep in the encode stack with a bare `Invalid checksum`).

The most common trigger is passing the account's **H160** (`0x…`):
pallet-revive derives the H160 `msg.sender` *from* the SS58 origin, so the
origin itself must be SS58. When the rejected value looks like an H160, the
message includes an `h160ToSs58` pointer. This is a validation error, not a
silent auto-conversion — converting here would hide which account the caller
believes is calling.

```typescript
class ContractInvalidOriginError extends ContractError {
    /** The rejected origin value. */
    readonly origin: string;
    constructor(origin: string)
}
```

---

## Types

### Result

Discriminated union returned by the async fallible APIs (`tx`, `prepare`,
`ContractManager.fromLive` / `fromLiveClient`, `withLiveContractAddresses`).

```typescript
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

### Contract

A contract handle with methods for each ABI function.

```typescript
type Contract<D extends ContractDef> = {
    [method: string]: {
        query(options?: QueryOptions): Promise<QueryResult>;
        tx(options?: TxOptions): Promise<Result<TxResult, ContractError | TxError>>;
    };
};
```

`query()` still returns `Promise<QueryResult>` and never throws on revert — a
reverted query comes back as `{ success: false }`. `tx()` returns a
`Result`: it no longer throws `ContractSignerMissingError`,
`ContractDryRunFailedError`, or `ContractRevertedError` — those come back as
`err`. Unwrap with the `ok` discriminant:

```typescript
const result = await counter.increment.tx({ signer });
if (!result.ok) {
    // result.error is a ContractError | TxError
    // (ContractSignerMissingError, ContractDryRunFailedError,
    //  ContractRevertedError, ...)
    throw result.error;
}
const { blockHash, events } = result.value;
```

### ContractDef

Definition of a contract's methods (from codegen).

```typescript
interface ContractDef {
    methods: Record<string, {
        args: unknown[];
        response: unknown;
    }>;
}
```

### QueryOptions

```typescript
interface QueryOptions {
    /** Caller for the dry-run. Must be SS58 — an H160 throws ContractInvalidOriginError. */
    origin?: SS58String;
    value?: bigint;
    /** Block to target: "best" (default) | "finalized" | block hash. */
    at?: ContractDryRunAt;
}
```

### QueryResult

```typescript
interface QueryResult {
    value: unknown;
    gasRequired: bigint;
}
```

### TxOptions

```typescript
interface TxOptions {
    signer?: PolkadotSigner;
    waitFor?: "best-block" | "finalized";
    onStatus?: (status: TxStatus) => void;
}
```

### TxResult

```typescript
interface TxResult {
    blockHash: string;
    events: unknown[];
}
```

### ContractDefaults

```typescript
interface ContractDefaults {
    signerManager?: SignerManager;
    /** Must be SS58 — an H160 throws ContractInvalidOriginError. */
    origin?: SS58String;
    signer?: PolkadotSigner;
}
```

### ContractManagerOptions

```typescript
interface ContractManagerOptions {
    signerManager?: SignerManager;
    /** Must be SS58 — an H160 throws ContractInvalidOriginError. */
    defaultOrigin?: SS58String;
    defaultSigner?: PolkadotSigner;
}
```

### LiveContractResolutionOptions

Options for the live-resolution factories (`fromLive`, `fromLiveClient`, `withLiveContractAddresses`).

```typescript
interface LiveContractResolutionOptions {
    /** CDM registry contract address. Defaults to `cdm.json.registry`. */
    registryAddress?: HexString;
    /** Subset of installed libraries to resolve. Defaults to every contract in the manifest. */
    libraries?: readonly string[];
    /** Origin used for CDM registry dry-run queries. Defaults to `defaultOrigin` in manager helpers. */
    registryOrigin?: SS58String;
}
```

### ContractOptions

```typescript
interface ContractOptions {
    signerManager?: SignerManager;
    /** Must be SS58 — an H160 throws ContractInvalidOriginError. */
    defaultOrigin?: SS58String;
    defaultSigner?: PolkadotSigner;
}
```

### CdmJson

The CDM manifest format.

```typescript
interface CdmJson {
    dependencies: Record<string, number | string>;
    contracts?: Record<string, CdmJsonContract>;
    registry?: HexString;
}

interface CdmJsonContract {
    version: number;
    address: HexString;
    abi: AbiEntry[];
    metadataCid?: string;
}
```

### AbiEntry

Solidity ABI entry format (also used for PolkaVM).

```typescript
interface AbiEntry {
    type: "function" | "constructor" | "event" | "error";
    name?: string;
    inputs: AbiParam[];
    outputs?: AbiParam[];
    stateMutability?: "pure" | "view" | "nonpayable" | "payable";
}

interface AbiParam {
    name: string;
    type: string;
    components?: AbiParam[];
}
```

## `./pvm` Subpath — cargo-pvm-contract Artefact Loaders

Imported from `@parity/product-sdk-contracts/pvm`. Parses the artefacts that
`cargo pvm-contract build` writes to `target/<name>.release.{abi.json,polkavm}`
into shapes the main `@parity/product-sdk-contracts` factories already accept.

### parsePvmContractAbi

In-memory parser. Browser-safe (no `node:fs` dependency).

```typescript
function parsePvmContractAbi(source: unknown): AbiEntry[];
```

Accepts a parsed `AbiEntry[]`, a wrapped `{ abi: AbiEntry[] }` object, a JSON
string of either, or a `Uint8Array` containing UTF-8 JSON of either. Throws if
the input cannot be coerced to an array of well-formed entries.

### loadPvmContractAbi

Async filesystem read + parse. **Node-only** — lazy-imports `node:fs/promises`.

```typescript
function loadPvmContractAbi(path: string): Promise<AbiEntry[]>;
```

### loadPvmContractArtifacts

Reads both `<basePath>.abi.json` and `<basePath>.polkavm` for a single
contract. Returns the parsed ABI plus the bytecode as a `Uint8Array`.

```typescript
function loadPvmContractArtifacts(basePath: string): Promise<PvmContractArtifacts>;

interface PvmContractArtifacts {
    abi: AbiEntry[];
    bytecode: Uint8Array;
}
```

Use the bytecode with `pallet-revive`'s `instantiate_with_code` to deploy. A
deploy helper is not yet part of `@parity/product-sdk-contracts`; reference
implementations live in consumer repos (e.g. `task-rabbit`'s
`packages/utils/src/deployer.ts`).
