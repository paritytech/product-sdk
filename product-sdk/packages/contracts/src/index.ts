/**
 * @parity/product-sdk-contracts — Typed contract interactions on Polkadot Asset Hub.
 *
 * Drives queries and transactions against deployed contracts from a Contract
 * Description Metadata (CDM) JSON file. `ContractManager` is the runtime entry
 * point; `generateContractTypes` produces the typed bindings at build time so
 * call sites get full inference for parameters and return values.
 *
 * @packageDocumentation
 */
export { ContractManager, createContract, createContractFromClient } from "./manager.js";
export { generateContractTypes } from "./codegen.js";
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
    ContractDefaults,
    ContractManagerOptions,
    ContractOptions,
} from "./types.js";
