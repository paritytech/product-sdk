// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Terminal Adapter
export {
    createTerminalAdapter,
    SS_STABLE_STAGE_ENDPOINTS,
    SS_PASEO_STABLE_STAGE_ENDPOINTS,
} from "./adapter.js";
export type { TerminalAdapterOptions, TerminalAdapter } from "./adapter.js";

// Session Signer
export { createSessionSigner, createSessionSignerForAccount } from "./signer.js";
export type { ProductAccountRef } from "./signer.js";

// Allowance service — `adapter.allowance` lives on every TerminalAdapter (inherited
// from host-papp's PappAdapter). These helpers default the session id to the only
// paired session and unwrap the underlying ResultAsync into a throw, matching the
// idiom of the rest of this package.
//
// The `has*Allowance` variants are cache-only probes that never prompt the
// paired wallet — safe to call from login health-check paths that must not
// surface a phone dialog.
export {
    getBulletinSigner,
    getStatementStoreProver,
    hasBulletinAllowance,
    hasStatementStoreAllowance,
} from "./allowance.js";
export { AllowanceError } from "@novasamatech/host-papp";
export type { AllowanceService, AllowanceErrorReason } from "@novasamatech/host-papp";

// Session helpers
export { waitForSessions } from "./sessions.js";

// QR Encoding
export { renderQrCode } from "./qr-encode.js";
export type { QrRenderOptions } from "./qr-encode.js";

// Storage adapter (advanced use — most callers get this implicitly via createTerminalAdapter)
export { createNodeStorageAdapter } from "./node-storage.js";

// Re-export SDK types consumers will need
export type {
    PappAdapter,
    HostMetadata,
    PairingStatus,
    UserSession,
    StoredUserSession,
    SigningPayloadRequest,
    SigningRawRequest,
    SigningPayloadResponse,
} from "@novasamatech/host-papp";
