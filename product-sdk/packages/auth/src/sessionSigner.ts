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
 * Lifted from playground-cli `src/utils/sessionSigner.ts` (issue #411). The
 * product id + derivation index are injected via `ProductAccountRef` so this
 * module is product-agnostic.
 *
 * **Why a local builder and not `createSessionSignerForAccount` from
 * `@parity/product-sdk-terminal`?**
 *
 * The SDK's "PR #81 fix" routes tx signing through
 * `session.signRaw({ data: { tag: "Payload", value: hex(toSign) } })`. Android
 * v1198 (and earlier) ALWAYS applies the `<Bytes>...</Bytes>` anti-phishing
 * envelope inside `SignRawInteractor.sign()` — so the resulting signature is
 * over `<Bytes>${utf8(hex)}</Bytes>`, NOT the bare extrinsic payload. The chain
 * reconstructs the bare payload, verifies, and rejects with
 * `{ type: "Invalid", value: { type: "BadProof" } }` on EVERY tx with the AsPgas
 * extension active.
 *
 * The canonical workaround comes from the Android team's own sample app:
 *
 *   1. Build a PJS-style signer with `getPolkadotSignerFromPjs(address, signPayload, signRaw)`.
 *   2. Provide a custom `signPayload` that maps PJS's `SignerPayloadJSON` onto
 *      host-papp's `SigningPayloadRequest` and forwards via `session.signPayload(...)`.
 *      Android's `signPayload` handler then reconstructs the full payload itself
 *      (including AsPgas sponsoring) and signs the bare bytes correctly.
 *   3. Wrap the resulting signer so that for `RELAXED_SIGNED_EXTENSIONS`
 *      (extensions PAPI sees but the PJS adapter can't recognize, e.g. `AsPgas`
 *      and `AsRingAlias`), we zero out `value` + `additionalSigned` BEFORE PJS
 *      walks them. That sidesteps PJS's "PJS does not support this
 *      signed-extension" throw WITHOUT dropping the identifier from
 *      `signedExtensions[]` — so android still knows to include them and fills
 *      in the correct encoding from its own runtime view.
 *
 * Replace this whole file with a `product-sdk-terminal` re-export once that
 * package's signer uses `session.signPayload` and ships the relaxed-extensions
 * wrapper natively.
 */

import { getPolkadotSignerFromPjs, type SignerPayloadJSON } from "polkadot-api/pjs-signer";
import { fromHex, toHex } from "polkadot-api/utils";
import { ss58Encode } from "@parity/product-sdk-address";
import type { UserSession } from "@parity/product-sdk-terminal";
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
 * Identifiers whose payload PAPI may populate but the PJS adapter doesn't
 * recognize. Mirrors `RELAXED_SIGNED_EXTENSIONS` in the polkadot-app sample.
 * Add to this set if a future runtime adds another v2-style extension PAPI
 * doesn't know about; android's host fills in the actual encoding.
 */
const RELAXED_SIGNED_EXTENSIONS: ReadonlySet<string> = new Set(["AsPgas", "AsRingAlias"]);

function asHexString(value: string | undefined): `0x${string}` | undefined {
    if (value === undefined) return undefined;
    // host-papp's SigningPayloadRequest types hex fields as `0x${string}`.
    // PJS adapter populates them via toPjsHex / toHex which produce hex strings;
    // cast through since the runtime values are guaranteed-prefixed.
    return value as `0x${string}`;
}

/**
 * Coerce PJS's `assetId: number | object | undefined` to host-papp's hex shape.
 *
 * For `ChargeAssetTxPayment` and `AsPgas`, the PJS mapper produces a `0x…`
 * string when the asset is set. Other shapes (number / nested object) shouldn't
 * surface in paseo-next-v2 today; we coerce defensively.
 */
function coerceAssetId(value: unknown): `0x${string}` | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string" && value.startsWith("0x")) return value as `0x${string}`;
    // Defensive fallback: stringify and warn upstream.
    return undefined;
}

export function createSessionSigner(
    session: UserSession,
    ref: ProductAccountRef,
): PolkadotSigner {
    // `session.remoteAccount.accountId` is the wallet's currently-selected
    // substrate account (`walletAccount.defaultAccountId()` on Android), NOT
    // the product-derived account that actually signs on-chain. Using it as
    // `signer.publicKey` would cause every funding / balance lookup / allowance
    // marker / display address to point at the wallet, while the
    // mobile-constructed `signedTransaction` carries a different `From`
    // (the product account derived at `/product/{productId}/{idx}`).
    //
    // `session.rootAccountId` is the handshake-time `rootUserAccountId` —
    // the user's bare-mnemonic keypair public key on current mobile builds
    // (`deriveRootAccount()` = `derivationPath = null`).
    const publicKey = deriveProductPublicKey(sessionRootPublicKey(session), ref);
    const address = ss58Encode(publicKey);

    // Wire-shape identifier passed to host-papp's `signPayload` / `signRaw`.
    // Has to be assembled here (not in derive) because the host-papp message
    // codec wants the productId/derivationIndex as a separate tuple field.
    const productAccountId: [string, number] = [ref.productId, ref.derivationIndex];

    const signPayload = async (pjs: SignerPayloadJSON) => {
        const result = await session.signPayload({
            productAccountId,
            blockHash: asHexString(pjs.blockHash) as `0x${string}`,
            blockNumber: asHexString(pjs.blockNumber) as `0x${string}`,
            era: asHexString(pjs.era) as `0x${string}`,
            genesisHash: asHexString(pjs.genesisHash) as `0x${string}`,
            method: asHexString(pjs.method) as `0x${string}`,
            nonce: asHexString(pjs.nonce) as `0x${string}`,
            specVersion: asHexString(pjs.specVersion) as `0x${string}`,
            tip: asHexString(pjs.tip) as `0x${string}`,
            transactionVersion: asHexString(pjs.transactionVersion) as `0x${string}`,
            signedExtensions: pjs.signedExtensions,
            version: pjs.version,
            assetId: coerceAssetId(pjs.assetId),
            metadataHash: asHexString(pjs.metadataHash),
            mode: pjs.mode,
            withSignedTransaction: pjs.withSignedTransaction,
        });
        if (result.isErr()) {
            throw new Error(`Mobile signing failed: ${result.error.message}`);
        }
        const data = result.value;
        return {
            signature: toHex(data.signature),
            signedTransaction: data.signedTransaction ? toHex(data.signedTransaction) : undefined,
        };
    };

    const signRaw = async (payload: { address: string; data: string; type: "bytes" }) => {
        if (!payload.data.startsWith("0x")) {
            throw new Error("Raw signing payload must be 0x-prefixed hex");
        }
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Bytes", value: fromHex(payload.data as `0x${string}`) },
        });
        if (result.isErr()) {
            throw new Error(`Mobile signing failed: ${result.error.message}`);
        }
        return { id: 0, signature: toHex(result.value.signature) };
    };

    const baseSigner = getPolkadotSignerFromPjs(address, signPayload, signRaw);

    // Relaxed-extensions wrapper — see the file-level comment.
    return {
        publicKey: baseSigner.publicKey,
        signBytes: baseSigner.signBytes,
        signTx: (callData, signedExtensions, metadata, atBlockNumber, hasher) => {
            const relaxed: typeof signedExtensions = {};
            for (const [identifier, ext] of Object.entries(signedExtensions)) {
                relaxed[identifier] = RELAXED_SIGNED_EXTENSIONS.has(identifier)
                    ? { ...ext, value: new Uint8Array(0), additionalSigned: new Uint8Array(0) }
                    : ext;
            }
            return baseSigner.signTx(callData, relaxed, metadata, atBlockNumber, hasher);
        },
    };
}
