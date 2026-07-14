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
 * Session-backed `PolkadotSigner` for a product account.
 *
 * The signer itself is built by `@parity/product-sdk-terminal`'s
 * `createSessionSignerForAccount`, which routes tx signing through
 * `session.createTransaction` (the wallet assembles + signs the extrinsic and
 * preserves chain-specific signed extensions like `AsPgas`/`AsRingAlias`
 * verbatim). This module only owns the product-account *derivation* — terminal
 * doesn't derive the product key, it expects the caller to pass it in
 * `ProductAccountRef.publicKey` — so `createSessionSigner` here derives that key
 * from the session root and delegates the rest.
 */

import type { UserSession } from "@parity/product-sdk-terminal";
import { createSessionSignerForAccount } from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";

export interface ProductAccountRef {
    productId: string;
    derivationIndex: number;
}

export const INCOMPLETE_SESSION_MESSAGE =
    'Stored login session is missing the root account public key. Run "logout" and then "login" to pair again.';

export function sessionRootPublicKey(session: UserSession): Uint8Array {
    const rootAccountId = (session as { rootAccountId?: Uint8Array }).rootAccountId;
    const publicKey = rootAccountId ? new Uint8Array(rootAccountId) : new Uint8Array();
    if (publicKey.length !== 32) {
        throw new Error(INCOMPLETE_SESSION_MESSAGE);
    }
    return publicKey;
}

/**
 * Soft-derive the product account public key off a wallet root.
 *
 * This is the single source of truth for product-account math. Both
 * `createSessionSigner` (which builds the signer used to actually sign
 * on-chain) and `deriveSessionAddresses` (which builds the display triple)
 * go through here so a future change to derivation params can't silently
 * desync the signer from what we print.
 *
 * sr25519 soft derivation is composable on public keys alone, so deriving
 * from `rootAccountId` locally produces the SAME public key the mobile
 * derives privately via `mnemonic + "/product/...{idx}"`. Algorithm parity
 * with mobile/desktop is locked by the frozen vectors in
 * `@parity/product-sdk-keys`'s `product-account.test.ts`.
 */
export function deriveProductPublicKey(
    rootAccountId: Uint8Array,
    ref: ProductAccountRef,
): Uint8Array {
    return deriveProductAccountPublicKey(rootAccountId, ref.productId, ref.derivationIndex);
}

/**
 * Build the session-backed `PolkadotSigner` for a product account.
 *
 * Derives the product account's public key from the session root (terminal
 * doesn't do this — it stamps whatever key we hand it into the extrinsic signer
 * address) and delegates the actual signing to terminal's
 * `createSessionSignerForAccount`. Sharing `deriveProductPublicKey` with
 * `deriveSessionAddresses` keeps the signing key and the displayed SS58/H160 in
 * lockstep: they're computed by exactly one function.
 */
export function createSessionSigner(session: UserSession, ref: ProductAccountRef): PolkadotSigner {
    // `session.remoteAccount.accountId` is the wallet's currently-selected
    // account — NOT the product-derived account that signs on-chain. Deriving
    // and passing `publicKey` explicitly is what makes terminal stamp the
    // product account (not the wallet) as the extrinsic signer.
    const publicKey = deriveProductPublicKey(sessionRootPublicKey(session), ref);
    return createSessionSignerForAccount(session, {
        productId: ref.productId,
        derivationIndex: ref.derivationIndex,
        publicKey,
    });
}
