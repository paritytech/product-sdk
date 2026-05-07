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
export { ContractManager, createContract, createContractFromClient } from "./manager.js";
export { createContractRuntime } from "./runtime.js";
export type { ContractRuntime, ReviveTypedApi, ReviveDryRunResult } from "./runtime.js";
export { generateContractTypes, resolveContractTypeInputs } from "./codegen.js";
export type { ContractTypeInput } from "./codegen.js";
export {
    ContractError,
    ContractSignerMissingError,
    ContractNotFoundError,
} from "./errors.js";
export type {
    CdmJson,
    CdmJsonTarget,
    CdmJsonContract,
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
} from "./types.js";
