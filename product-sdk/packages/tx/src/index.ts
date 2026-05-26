// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-tx — Submit Polkadot transactions and follow them to finality.
 *
 * `submitAndWatch` signs, broadcasts, and tracks a single extrinsic through its
 * lifecycle; `batchSubmitAndWatch` does the same for a list of calls. The package
 * also bundles the things you almost always reach for next to a real submission:
 * dry-run helpers, Asset Hub account mapping, retry primitives, dev signers, and
 * a typed error hierarchy with formatters that turn dispatch errors into readable
 * messages.
 *
 * @packageDocumentation
 */
export { submitAndWatch } from "./submit.js";
export { batchSubmitAndWatch } from "./batch.js";
export { withRetry, calculateDelay } from "./retry.js";
export { createDevSigner, getDevPublicKey } from "./dev-signers.js";
export { extractTransaction, applyWeightBuffer } from "./dry-run.js";
export { ensureAccountMapped, isAccountMapped, TxAccountMappingError } from "./account-mapping.js";
export type {
    MappingChecker,
    ReviveApi,
    EnsureAccountMappedOptions,
} from "./account-mapping.js";
export {
    TxError,
    TxTimeoutError,
    TxDispatchError,
    TxDryRunError,
    TxSigningRejectedError,
    TxBatchError,
    formatDispatchError,
    formatDryRunError,
    isSigningRejection,
} from "./errors.js";
export type {
    TxStatus,
    WaitFor,
    TxResult,
    SubmitOptions,
    RetryOptions,
    DevAccountName,
    Weight,
    SubmittableTransaction,
    TxEvent,
    BatchMode,
    BatchableCall,
    BatchSubmitOptions,
    BatchApi,
} from "./types.js";
