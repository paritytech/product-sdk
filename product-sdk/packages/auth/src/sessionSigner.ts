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
 * Session-backed signing for a product account.
 *
 * All of this lives in `@parity/product-sdk-terminal` — the session signer, the
 * product-account derivation, and the stale-session guard. This module is a
 * thin re-export so auth consumers get one import surface; nothing is
 * implemented twice.
 */

export {
    createSessionSignerForAccount as createSessionSigner,
    deriveProductPublicKey,
    sessionRootPublicKey,
    INCOMPLETE_SESSION_MESSAGE,
} from "@parity/product-sdk-terminal";
export type { ProductAccountRef } from "@parity/product-sdk-terminal";
