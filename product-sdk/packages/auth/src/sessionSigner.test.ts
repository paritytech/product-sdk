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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ss58Encode } from "@parity/product-sdk-address";
import { deriveProductAccountPublicKey, seedToAccount } from "@parity/product-sdk-keys";
import type { UserSession } from "@parity/product-sdk-terminal";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSessionSigner } from "./sessionSigner.js";

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const PRODUCT_ID = "playground.dot";

// Guards the two keys that have each wrongly occupied the signer slot: the
// wallet account, and the root.
describe("session signer account equivalence", () => {
    let storageDir: string;
    let sessionCount = 0;

    beforeEach(() => {
        storageDir = mkdtempSync(join(tmpdir(), "auth-signer-"));
        return () => rmSync(storageDir, { recursive: true, force: true });
    });

    const subtreeAccount = (mnemonic: string) =>
        seedToAccount(mnemonic, `//product//${PRODUCT_ID}`);

    function fakeSession(mnemonic: string): UserSession {
        const root = seedToAccount(mnemonic, "");
        const wallet = seedToAccount(mnemonic, "//SomeWallet");
        const subtree = subtreeAccount(mnemonic);
        return {
            // Unique per session: the subtree cache memoizes on it.
            id: `test-${sessionCount++}`,
            localAccount: { accountId: new Uint8Array(32), pin: undefined },
            remoteAccount: {
                accountId: wallet.publicKey,
                publicKey: wallet.publicKey,
                pin: undefined,
            },
            rootAccountId: root.publicKey,
            getProductSubtree: vi.fn(async () => ({
                isErr: () => false,
                value: subtree.publicKey,
            })),
        } as unknown as UserSession;
    }

    const signerFor = (session: UserSession) =>
        createSessionSigner(session, { productId: PRODUCT_ID, derivationIndex: 0 }, { storageDir });

    test("signs as the product account derived from the subtree key", async () => {
        const session = fakeSession(DEV_PHRASE);
        const signer = await signerFor(session);

        const expected = deriveProductAccountPublicKey(subtreeAccount(DEV_PHRASE).publicKey, {
            tag: "Index",
            value: 0,
        });
        expect(ss58Encode(signer.publicKey)).toEqual(ss58Encode(expected));
    });

    test("does not use remoteAccount.accountId, the wallet account", async () => {
        const session = fakeSession(DEV_PHRASE);
        const signer = await signerFor(session);
        const wallet = ss58Encode(new Uint8Array(session.remoteAccount.accountId));

        expect(ss58Encode(signer.publicKey)).not.toEqual(wallet);
    });

    test("does not use rootAccountId, which cannot cross the hard junctions", async () => {
        const session = fakeSession(DEV_PHRASE);
        const signer = await signerFor(session);
        const root = ss58Encode(seedToAccount(DEV_PHRASE, "").publicKey);

        expect(ss58Encode(signer.publicKey)).not.toEqual(root);
    });
});
