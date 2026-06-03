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
