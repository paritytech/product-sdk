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
import { getDevPublicKey } from "@parity/product-sdk-tx";
import { seedToAccount } from "@parity/product-sdk-keys";
import { resolveSigner, SignerNotAvailableError, parseDevAccountName } from "./signer.js";
import type { AuthClient } from "./auth.js";

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

// Minimal AuthClient stub — only `getSessionSigner` is exercised by resolveSigner.
function stubAuthClient(session: Awaited<ReturnType<AuthClient["getSessionSigner"]>>): AuthClient {
    return {
        getSessionSigner: async () => session,
    } as unknown as AuthClient;
}

describe("parseDevAccountName", () => {
    test("recognizes well-known dev SURIs (exact case, // prefix)", () => {
        expect(parseDevAccountName("//Alice")).toBe("Alice");
        expect(parseDevAccountName("//Bob")).toBe("Bob");
    });
    test("requires the // prefix — a bare name is not a dev SURI", () => {
        expect(parseDevAccountName("Alice")).toBeNull();
    });
    test("is case-sensitive, matching Substrate SURI semantics", () => {
        expect(parseDevAccountName("//alice")).toBeNull();
        expect(parseDevAccountName("//BOB")).toBeNull();
    });
    test("returns null for non-dev suris", () => {
        expect(parseDevAccountName("//NotADev")).toBeNull();
        expect(parseDevAccountName(DEV_PHRASE)).toBeNull();
    });
});

describe("resolveSigner", () => {
    const noSession = stubAuthClient(null);

    test("--suri //Alice → dev signer at Alice's address", async () => {
        const r = await resolveSigner(noSession, { suri: "//Alice" });
        expect(r.source).toBe("dev");
        expect(r.address).toBe(ss58Encode(getDevPublicKey("Alice")));
    });

    test("--suri <mnemonic> → dev signer at the seed-derived address", async () => {
        const r = await resolveSigner(noSession, { suri: DEV_PHRASE });
        expect(r.source).toBe("dev");
        expect(r.address).toBe(ss58Encode(seedToAccount(DEV_PHRASE, "").publicKey));
    });

    test("--suri <mnemonic>//path → dev signer at the derived sub-account", async () => {
        const r = await resolveSigner(noSession, { suri: `${DEV_PHRASE}//stash` });
        expect(r.source).toBe("dev");
        expect(r.address).toBe(ss58Encode(seedToAccount(DEV_PHRASE, "//stash").publicKey));
    });

    test("garbage suri → throws 'Unrecognized SURI'", async () => {
        await expect(resolveSigner(noSession, { suri: "not a valid suri !!" })).rejects.toThrow(
            /Unrecognized SURI/,
        );
    });

    test("no suri + no session → SignerNotAvailableError", async () => {
        await expect(resolveSigner(noSession)).rejects.toBeInstanceOf(SignerNotAvailableError);
    });

    test("no suri + a session → session signer (source 'session')", async () => {
        const fakeHandle = {
            address: "5SESSION",
            addresses: {
                rootAddress: "r",
                productAddress: "5SESSION",
                productH160: "0xabc" as `0x${string}`,
            },
            signer: {} as never,
            userSession: {} as never,
            destroy() {},
        };
        const r = await resolveSigner(stubAuthClient(fakeHandle));
        expect(r.source).toBe("session");
        expect(r.address).toBe("5SESSION");
    });
});
