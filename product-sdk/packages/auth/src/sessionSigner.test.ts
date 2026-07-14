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

import { describe, expect, test } from "vitest";
import { ss58Encode } from "@parity/product-sdk-address";
import { seedToAccount } from "@parity/product-sdk-keys";
import type { UserSession } from "@parity/product-sdk-terminal";
import { createSessionSigner } from "./sessionSigner.js";

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
// Injected product id (the consumer supplies this via ProductAccountRef). Uses
// the same value playground derives from so the product account is identical.
const PRODUCT_ID = "playground.dot";

// ────────────────────────────────────────────────────────────────────────────
// Account equivalence — pins the invariant that every flow which references
// "the user's account" resolves to the *same* SS58: the product account
// derived at `mnemonic + "/product/{PRODUCT_ID}/0"`.
//
// The signer built by `createSessionSigner(session, {productId, derivationIndex})`
// must SS58-equal the mobile/playground-app derivation
// `seedToAccount(mnemonic, "/product/{PRODUCT_ID}/0")`. These tests are the
// regression guard against the pre-fix bug where the signer used the wallet
// account (`remoteAccount.accountId`) instead of the product account.
// ────────────────────────────────────────────────────────────────────────────
describe("session signer account equivalence", () => {
    // Stand-in for the mobile's SSO handshake response: `rootAccountId` is
    // `deriveRootAccount()` on the mobile = the bare-mnemonic keypair pubkey.
    // Other fields aren't read by `createSessionSigner` in the path under test.
    function fakeSession(mnemonic: string): UserSession {
        const root = seedToAccount(mnemonic, "");
        const wallet = seedToAccount(mnemonic, "//SomeWallet"); // user picking a derived account on mobile
        return {
            id: "test",
            localAccount: { accountId: new Uint8Array(32), pin: undefined },
            remoteAccount: {
                accountId: wallet.publicKey,
                publicKey: wallet.publicKey,
                pin: undefined,
            },
            rootAccountId: root.publicKey,
        } as unknown as UserSession;
    }

    test("session signer address === product-account derivation address", () => {
        const session = fakeSession(DEV_PHRASE);

        const cliSigner = createSessionSigner(session, {
            productId: PRODUCT_ID,
            derivationIndex: 0,
        });
        const cliAddress = ss58Encode(cliSigner.publicKey);

        const mobileDerived = seedToAccount(DEV_PHRASE, `/product/${PRODUCT_ID}/0`);
        const productAccountAddress = ss58Encode(mobileDerived.publicKey);

        expect(cliAddress).toEqual(productAccountAddress);
    });

    test("regression: signer does NOT use remoteAccount.accountId (= wallet account)", () => {
        const session = fakeSession(DEV_PHRASE);
        const cliSigner = createSessionSigner(session, {
            productId: PRODUCT_ID,
            derivationIndex: 0,
        });
        const cliAddress = ss58Encode(cliSigner.publicKey);
        const walletAddress = ss58Encode(new Uint8Array(session.remoteAccount.accountId));

        // Pre-fix bug: signer.publicKey was set from session.remoteAccount.accountId
        // (the user's wallet account), not the product-derived account. The wallet
        // account is what the chain would see as From — different from the funded /
        // allowance-granted product account. This guard ensures we never slip back.
        expect(cliAddress).not.toEqual(walletAddress);
    });

    test("reports stale sessions without a root account public key", () => {
        const session = {
            ...fakeSession(DEV_PHRASE),
            rootAccountId: new Uint8Array(),
        } as UserSession;

        expect(() =>
            createSessionSigner(session, {
                productId: PRODUCT_ID,
                derivationIndex: 0,
            }),
        ).toThrow("Stored login session is missing the root account public key.");
    });
});
