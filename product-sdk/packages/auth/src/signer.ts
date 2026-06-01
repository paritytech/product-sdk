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
 * Unified signer resolution — "give me a PolkadotSigner, I don't care how."
 * Lifted from playground-cli `src/utils/signer.ts` (issue #411).
 *
 * Dev accounts (`--suri //Alice`) and QR mobile sessions both produce the same
 * `PolkadotSigner` interface. Consumers call `resolveSigner(authClient)` once at
 * startup and thread the result through all operations. The `authClient` (from
 * `createAuthClient`) supplies the session branch, so this module stays free of
 * product-specific config.
 */

import { ss58Encode } from "@parity/product-sdk-address";
import { createDevSigner, getDevPublicKey, type DevAccountName } from "@parity/product-sdk-tx";
import { seedToAccount } from "@parity/product-sdk-keys";
import type { PolkadotSigner } from "polkadot-api";
import type { AuthClient, SessionAddresses, SessionHandle } from "./auth.js";

export type SignerSource = "dev" | "session";

export interface ResolvedSigner {
    signer: PolkadotSigner;
    address: string;
    source: SignerSource;
    /** Present for QR/mobile sessions; absent for local dev/SURI signers. */
    userSession?: SessionHandle["userSession"];
    /** Root / product / H160 triple — present for QR/mobile sessions only. */
    addresses?: SessionAddresses;
    /** Tear down session adapter. Call in a finally block. No-op for dev signers. */
    destroy(): void;
}

export interface SignerOptions {
    /** Secret URI like "//Alice". Takes priority over session. */
    suri?: string;
}

export class SignerNotAvailableError extends Error {
    constructor() {
        super('No signer available. Run "login" to sign in, or pass --suri //Alice for dev.');
        this.name = "SignerNotAvailableError";
    }
}

const DEV_NAMES: readonly DevAccountName[] = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Ferdie"];

export function parseDevAccountName(suri: string): DevAccountName | null {
    const name = suri.replace(/^\/\//, "");
    return DEV_NAMES.find((n) => n.toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * Resolve a PolkadotSigner.
 *
 *   1. `--suri` flag → dev signer (dev name like //Alice, OR a BIP-39 mnemonic
 *      with optional `//<path>` derivation suffix)
 *   2. Persisted QR session → session signer (via `authClient.getSessionSigner`)
 *   3. Neither → `SignerNotAvailableError`
 */
export async function resolveSigner(
    authClient: AuthClient,
    options?: SignerOptions,
): Promise<ResolvedSigner> {
    if (options?.suri) {
        const devName = parseDevAccountName(options.suri);
        if (devName) {
            return {
                signer: createDevSigner(devName),
                address: ss58Encode(getDevPublicKey(devName)),
                source: "dev",
                destroy() {},
            };
        }
        // Mnemonic path. Split off an optional `//<path>` derivation suffix so
        // callers can target a sub-account of the same seed without a separate flag.
        const sepIdx = options.suri.indexOf("//");
        const mnemonic = (sepIdx === -1 ? options.suri : options.suri.slice(0, sepIdx)).trim();
        const path = sepIdx === -1 ? "" : options.suri.slice(sepIdx);
        try {
            const account = seedToAccount(mnemonic, path);
            return {
                signer: account.signer,
                address: ss58Encode(account.publicKey),
                source: "dev",
                destroy() {},
            };
        } catch {
            throw new Error(
                `Unrecognized SURI "${options.suri}". ` +
                    `Expected a dev name (${DEV_NAMES.join(", ")}) or a BIP-39 mnemonic.`,
            );
        }
    }

    const session = await authClient.getSessionSigner();
    if (session) {
        return { ...session, source: "session" };
    }

    throw new SignerNotAvailableError();
}
