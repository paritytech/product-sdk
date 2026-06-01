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
 * Per-product configuration injected into `createAuthClient`. Lifting the
 * sign-in glue out of playground-cli (issue #411) means the env-specific
 * constants playground hard-coded in its `config.ts` (DAPP_ID, product id,
 * metadata URL, People-chain endpoints) become consumer-supplied so the same
 * package serves `playground` and `dot` (and future products) unchanged.
 */
export interface AuthConfig {
    /** The dApp identity string. Scopes the on-disk session namespace
     *  (`~/.polkadot-apps/${dappId}_*`) and the SSO pairing — each product
     *  gets its own, independently-revocable session. */
    dappId: string;
    /** Product id used to derive the product account (`/product/{productId}/{index}`). */
    productId: string;
    /** Derivation index of the product account (0 = default). */
    derivationIndex: number;
    /** Hosted app-metadata doc (name/icon) the mobile wallet reads at pairing. */
    metadataUrl: string;
    /** People-parachain RPC endpoints the terminal adapter connects to. */
    peopleEndpoints: string[];
}
