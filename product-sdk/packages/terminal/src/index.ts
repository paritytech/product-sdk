// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `@parity/product-sdk-terminal`: QR pairing and signing for CLIs, through the
 * truapi core every Polkadot host runs.
 */

export { createTerminalAdapter, defaultStorageDir } from "./adapter.js";
export type {
    LoginOptions,
    TerminalAdapter,
    TerminalAdapterOptions,
    TerminalSession,
} from "./adapter.js";
export { approveAll } from "./host-callbacks/approvals.js";
export type { TerminalApprovalRequest, TerminalApprovals } from "./host-callbacks/approvals.js";
export { TerminalNetworks } from "./networks.js";
export type { TerminalChain, TerminalNetwork, TerminalNetworkName } from "./networks.js";
export {
    createSessionSigner,
    createSessionSignerForAccount,
    deriveProductPublicKey,
    sessionRootPublicKey,
} from "./signer.js";
export type { ProductAccountRef, SessionSignerOptions } from "./signer.js";
export { AllowanceExpiredError, SignerError } from "@parity/product-sdk-signer/errors";
export { requestResourceAllocation } from "./allocations.js";
export type { AllocatableResource, AllocationOutcome } from "./allocations.js";
export { getStatementStoreProver, submitPreimage, submitStatement } from "./statement-store.js";
export type {
    SignedStatement,
    Statement,
    StatementProof,
    StatementStoreProver,
} from "./statement-store.js";
export { deriveEntropy } from "./entropy.js";
export { renderQrCode } from "./qr-encode.js";
export type { QrRenderOptions } from "./qr-encode.js";
export type { AuthState } from "@parity/truapi-host";
