// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * RFC-0022 product-account public-key derivation, matching
 * `host_logic/product_account.rs` in host-rust-core.
 *
 * A product account sits at `//product//{productId}/{derivationIndex}`. The two
 * `//product//{productId}` junctions are hard, which is the security boundary
 * and also why a root public key cannot reach a product account: the subtree
 * public key has to come from the Account Holder via `getProductSubtree`.
 */

import { type DerivationIndex, derivationIndexBytes } from "@parity/product-sdk-utils";
import { HDKD } from "@scure/sr25519";

/**
 * Soft-derive one product account's sr25519 public key.
 *
 * @param productSubtreePublicKey 32-byte public key of `//product//{productId}`,
 *   as returned by `getProductSubtree`.
 * @throws Error if the subtree key is not a valid sr25519 point, or the index is
 *   out of range.
 */
export function deriveProductAccountPublicKey(
    productSubtreePublicKey: Uint8Array,
    derivationIndex: DerivationIndex,
): Uint8Array {
    return HDKD.publicSoft(productSubtreePublicKey, derivationIndexBytes(derivationIndex));
}
