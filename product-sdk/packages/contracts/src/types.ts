import type { HexString, PolkadotSigner, SS58String } from "polkadot-api";
import type { BatchableCall, SubmitOptions, TxResult, Weight } from "@parity/product-sdk-tx";
import type { SignerManager } from "@parity/product-sdk-signer";

// Re-export from the tx package — single source of truth.
export type { TxResult, SubmitOptions, BatchableCall } from "@parity/product-sdk-tx";

// ---------------------------------------------------------------------------
// cdm.json schema
// ---------------------------------------------------------------------------

/** Pins a target to specific asset-hub and Bulletin chain hashes in `cdm.json`. */
export interface CdmJsonTarget {
    "asset-hub": string;
    bulletin: string;
}

/**
 * A deployed contract's on-chain address, ABI, and optional metadata CID.
 *
 * `metadataCid` is optional because real-world cdm.json files (e.g.
 * `paritytech/playground-cli/cdm.json`) don't always include it — only
 * `version`, `address`, and `abi` are load-bearing for `getContract()`.
 */
export interface CdmJsonContract {
    version: number;
    address: HexString;
    abi: AbiEntry[];
    metadataCid?: string;
}

/** A project's `cdm.json` manifest: declared targets, runtime dependencies, and per-target contract deployments. */
export interface CdmJson {
    targets: Record<string, CdmJsonTarget>;
    dependencies: Record<string, Record<string, number | string>>;
    contracts?: Record<string, Record<string, CdmJsonContract>>;
}

// ---------------------------------------------------------------------------
// ABI types (Solidity-compatible, used by both Ink!/PolkaVM and Solidity)
// ---------------------------------------------------------------------------

/** An ABI parameter or return value, with support for nested tuple and struct types. */
export interface AbiParam {
    name: string;
    type: string;
    components?: AbiParam[];
}

/** One function, constructor, or event in a contract's ABI. */
export interface AbiEntry {
    type: string;
    name?: string;
    inputs: AbiParam[];
    outputs?: AbiParam[];
    stateMutability?: string;
}

// ---------------------------------------------------------------------------
// Contract type system
// ---------------------------------------------------------------------------

/** Per-contract definition shape — generated into `.cdm/contracts.d.ts` via module augmentation. */
export interface ContractDef {
    methods: Record<string, { args: any[]; response: any }>;
}

/**
 * Augmentable interface extended by codegen with per-contract method types.
 *
 * After running `cdm install`, a generated `.d.ts` file augments this
 * interface so that `ContractManager.getContract()` returns fully-typed
 * contract handles.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by codegen
export interface Contracts {}

/** Result from a read-only contract query. */
export interface QueryResult<T> {
    success: boolean;
    value: T;
    gasRequired?: bigint;
}

/** Options for query calls — passed as the last argument after positional args. */
export interface QueryOptions {
    origin?: SS58String;
    value?: bigint;
}

/** Options for transaction calls — passed as the last argument after positional args. */
export interface TxOptions extends SubmitOptions {
    signer?: PolkadotSigner;
    origin?: SS58String;
    value?: bigint;
    gasLimit?: Weight;
    storageDepositLimit?: bigint;
}

/**
 * Options for `.prepare()` — subset of {@link TxOptions}.
 *
 * Signer and submission lifecycle options (`signer`, `waitFor`, `timeoutMs`,
 * `mortalityPeriod`, `onStatus`) are intentionally absent — those belong to
 * the batch submission, not the individual prepared call.
 */
export interface PrepareOptions {
    origin?: SS58String;
    value?: bigint;
    gasLimit?: Weight;
    storageDepositLimit?: bigint;
}

/** Mutable defaults shared across all contract handles from a manager. */
export interface ContractDefaults {
    origin?: SS58String;
    signer?: PolkadotSigner;
    signerManager?: SignerManager;
}

/**
 * Options for {@link createContract} and base for {@link ContractManagerOptions}.
 *
 * Signer resolution order (highest wins):
 * 1. Explicit override in call options
 * 2. `signerManager` (current logged-in account)
 * 3. Static `defaultSigner` / `defaultOrigin`
 */
export interface ContractOptions {
    /**
     * Signer manager from `@parity/product-sdk-signer`. When provided, the
     * currently selected account is used as the default signer and origin
     * for all contract interactions. Resolved at call time so account
     * switches are reflected immediately.
     */
    signerManager?: SignerManager;
    /** Static fallback caller address for queries. */
    defaultOrigin?: SS58String;
    /** Static fallback signer for transactions. */
    defaultSigner?: PolkadotSigner;
}

/** Options for {@link ContractManager} construction. */
export interface ContractManagerOptions extends ContractOptions {
    /** Explicit target hash to select from cdm.json. Defaults to the first target. */
    targetHash?: string;
}

/**
 * A typed contract handle where each ABI method exposes `.query()` and `.tx()`.
 *
 * Both accept the method's positional arguments followed by an optional
 * options object as the last argument.
 */
export type Contract<C extends ContractDef> = {
    [K in keyof C["methods"]]: {
        /**
         * Dry-run the method (read-only). Does not submit a transaction or
         * cost gas. Returns the decoded response and estimated gas required.
         *
         * Origin is resolved from: explicit `{ origin }` option → signerManager →
         * defaultOrigin → dev fallback (Alice).
         */
        query: (
            ...args: [...C["methods"][K]["args"], opts?: QueryOptions]
        ) => Promise<QueryResult<C["methods"][K]["response"]>>;
        /**
         * Sign, submit, and watch the method as an on-chain transaction.
         * Resolves at best-block by default (configurable via `waitFor`).
         *
         * Signer is resolved from: explicit `{ signer }` option → signerManager →
         * defaultSigner. Throws {@link ContractSignerMissingError} if none available.
         */
        tx: (...args: [...C["methods"][K]["args"], opts?: TxOptions]) => Promise<TxResult>;
        /**
         * Prepare the method as a {@link BatchableCall} — returns a handle
         * consumable by `batchSubmitAndWatch` from `@parity/product-sdk-tx`
         * without signing or submitting.
         *
         * Use this to group multiple contract calls (or contract calls mixed
         * with other transactions on the same chain) into a single atomic
         * `Utility.batch_all` transaction:
         *
         * ```ts
         * import { batchSubmitAndWatch } from "@parity/product-sdk-tx";
         *
         * const a = contract.transfer.prepare(addr1, 100n);
         * const b = contract.transfer.prepare(addr2, 200n);
         * await batchSubmitAndWatch([a, b], api, signer);
         * ```
         *
         * Origin is resolved the same way as `.tx()` but falls back to the
         * dev address for dry-run gas estimation if no signer context is
         * available (prepare does not require a signer; the batch submission
         * does).
         */
        prepare: (...args: [...C["methods"][K]["args"], opts?: PrepareOptions]) => BatchableCall;
    };
};
