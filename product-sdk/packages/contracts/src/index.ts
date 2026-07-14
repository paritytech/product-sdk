// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-contracts — Typed contract interactions on Polkadot Asset Hub.
 *
 * Drives queries and transactions against deployed PolkaVM/Solidity contracts
 * via `pallet-revive`. ABIs are consumed from a Contract Description Metadata
 * (CDM) manifest or directly from `cargo-pvm-contract` build artefacts. The
 * Solidity ABI codec is delegated to `viem`; transactions and dry-runs go
 * through PAPI typed APIs (`Revive.call` / `ReviveApi.call`).
 *
 * @packageDocumentation
 */
export {
    ContractManager,
    createContract,
    createContractFromClient,
    withLiveContractAddresses,
} from "./manager.js";
export {
    createContractRuntime,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
} from "./runtime.js";
// pallet-revive's keyless account, used as the read-only query origin when no
// wallet is connected. Exported so other products can reuse the same origin
// instead of re-deriving it.
export { QUERY_FALLBACK_ORIGIN } from "./wrap.js";
export type {
    ContractRuntime,
    ContractRuntimeOptions,
    ContractDryRunAt,
    ReviveTypedApi,
    ReviveDryRunResult,
    ReviveDryRunCall,
    ReviveDryRunCallOptions,
} from "./runtime.js";
// Build-time codegen helpers (`generateContractTypes`, `resolveContractTypeInputs`)
// live behind the `@parity/product-sdk-contracts/codegen` subpath. Keeping them
// off the runtime entry prevents pulling Node-only `fs/os/path` dynamic imports
// (via `pvm.ts`) into browser bundles that only need `ContractManager`.
export {
    ContractError,
    ContractSignerMissingError,
    ContractNotFoundError,
    ContractLiveAddressResolutionError,
    ContractDryRunFailedError,
    ContractRevertedError,
} from "./errors.js";
export type { ContractRevertInfo, DecodedContractRevert } from "./errors.js";
export type {
    CdmJson,
    CdmJsonContract,
    CdmJsonDependencyVersion,
    AbiParam,
    AbiEntry,
    ContractDef,
    Contracts,
    Contract,
    QueryResult,
    QueryOptions,
    TxOptions,
    TxResult,
    PrepareOptions,
    BatchableCall,
    ContractDefaults,
    ContractManagerOptions,
    ContractOptions,
    LiveContractResolutionOptions,
} from "./types.js";
