// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @parity/product-sdk-auth — QR/mobile sign-in + session signing for Polkadot
 * product CLIs. Runtime-agnostic core (no terminal UI). UI helpers (QR render,
 * status formatters) live under the `./ui` entrypoint so headless consumers
 * don't pull terminal-rendering.
 */

export { createAuthClient } from "./auth.js";
export type {
    AuthClient,
    SessionAddresses,
    ConnectResult,
    LoginStatus,
    LoginHandle,
    SessionHandle,
    LogoutStatus,
    LogoutHandle,
} from "./auth.js";

export {
    createSessionSigner,
    deriveProductPublicKey,
    sessionRootPublicKey,
    INCOMPLETE_SESSION_MESSAGE,
} from "./sessionSigner.js";
export type { ProductAccountRef } from "./sessionSigner.js";

export { resolveSigner, SignerNotAvailableError, parseDevAccountName } from "./signer.js";
export type { ResolvedSigner, SignerSource, SignerOptions } from "./signer.js";

export { requestResourceAllocation, summarizeOutcomes, DEFAULT_RESOURCES } from "./allocations.js";
export type {
    AllocatableResource,
    AllocationOutcome,
    AllocationSummary,
    OnExistingAllowancePolicy,
    ResourceTag,
} from "./allocations.js";

export type { AuthConfig } from "./types.js";
