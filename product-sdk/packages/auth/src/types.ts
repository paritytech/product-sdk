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

import type {
    TerminalApprovals,
    TerminalNetwork,
    TerminalNetworkName,
} from "@parity/product-sdk-terminal";

/**
 * Per-product configuration for `createAuthClient`, so the same sign-in flow
 * serves every CLI product.
 */
export interface AuthConfig {
    /** The CLI's own id. Names its storage directory, so each CLI is signed in independently. */
    dappId: string;
    /**
     * The dotNS product id the CLI acts as, e.g. `"my-cli.dot"`. The signing
     * account is derived under it (`/product/{productId}/{index}`).
     */
    productId: string;
    /** Derivation index of the product account; `0` is the default. */
    derivationIndex: number;
    /** Chains to pair and sign over. Defaults to `"paseo-next-v2"`. */
    network?: TerminalNetworkName | TerminalNetwork;
    /**
     * This CLI's own directory, holding the session in `core/` and `product/`.
     * Defaults to `~/.polkadot-apps/<dappId>`. Logout removes only those two folders.
     */
    storageDir?: string;
    /** Answers the core's reviews and permission requests. Defaults to approving them. */
    approvals?: TerminalApprovals;
}
