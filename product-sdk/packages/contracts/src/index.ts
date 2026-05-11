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
export {
    createContractRuntime,
    createContractRuntimeFromClient,
    ensureContractAccountMapped,
} from "./runtime.js";
export type {
    ContractRuntime,
    ReviveTypedApi,
    ReviveDryRunResult,
    ReviveDryRunCall,
} from "./runtime.js";
// Build-time codegen helpers (`generateContractTypes`, `resolveContractTypeInputs`)
// live behind the `@parity/product-sdk-contracts/codegen` subpath. Keeping them
// off the runtime entry prevents pulling Node-only `fs/os/path` dynamic imports
// (via `pvm.ts`) into browser bundles that only need `ContractManager`.
export {
    ContractError,
    ContractSignerMissingError,
    ContractNotFoundError,
    ContractDryRunFailedError,
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
