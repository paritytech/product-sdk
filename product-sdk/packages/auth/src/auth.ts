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
 * QR sign-in for CLI products, without UI:
 *
 *   1. `connect()` returns the stored session's address, or a QR code to show.
 *   2. `waitForLogin()` waits for the phone to finish pairing.
 *   3. `getSessionSigner()` signs as the product account through the wallet.
 *   4. `requestAllocation()` asks the wallet for the allowances a new session needs.
 *   5. `findSession()` / `waitForLogout()` sign out.
 */

import type { Dirent } from "node:fs";
import { readdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveH160, ss58Encode } from "@parity/product-sdk-address";
import { createLogger } from "@parity/product-sdk-logger";
import {
    createTerminalAdapter,
    defaultStorageDir,
    renderQrCode,
    type TerminalAdapter,
    type TerminalSession,
} from "@parity/product-sdk-terminal";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import {
    createSessionSigner,
    deriveProductPublicKey,
    sessionRootPublicKey,
} from "./sessionSigner.js";
import {
    requestResourceAllocation,
    DEFAULT_RESOURCES,
    type AllocatableResource,
    type AllocationOutcome,
} from "./allocations.js";
import type { AuthConfig } from "./types.js";

const log = createLogger("auth");

/** How long to wait for the core to produce the pairing QR. */
const QR_TIMEOUT_MS = 60_000;

/** The adapter's thread keeps the process alive, so it must always stop; a failure there is only logged. */
function destroyQuietly(adapter: TerminalAdapter): void {
    adapter.destroy().catch((cause) => {
        log.debug("terminal adapter destroy() failed during cleanup", cause);
    });
}

/**
 * The addresses shown for a paired session.
 *
 * - `rootAddress`: the wallet's root account.
 * - `productAddress`: the product account `/product/{productId}/{index}`, which signs.
 * - `productH160`: the same product account as a 20-byte EVM address.
 */
export interface SessionAddresses {
    rootAddress: string;
    productAddress: string;
    productH160: `0x${string}`;
}

export type ConnectResult =
    | { kind: "existing"; address: string; addresses: SessionAddresses }
    | { kind: "qr"; qrCode: string; login: LoginHandle };

export type LoginStatus =
    | { step: "waiting" }
    | { step: "paired" }
    | { step: "success"; address: string; addresses: SessionAddresses }
    | { step: "error"; message: string };

export interface LoginHandle {
    adapter: TerminalAdapter;
    /** The login started by `connect()`, resolving once the phone finishes pairing. */
    session: Promise<TerminalSession>;
}

/** A signer for the product account, with the adapter it signs through. Call `destroy()` when done. */
export interface SessionHandle {
    address: string;
    addresses: SessionAddresses;
    signer: CommonSignerTxCreator;
    adapter: TerminalAdapter;
    session: TerminalSession;
    destroy(): void;
}

export type LogoutStatus =
    | { step: "disconnecting"; address: string }
    | { step: "success"; address: string }
    | { step: "partial"; address: string; reason: string }
    | { step: "error"; message: string };

export interface LogoutHandle {
    adapter: TerminalAdapter;
    address: string;
}

/** The product-bound auth surface returned by `createAuthClient`. */
export interface AuthClient {
    connect(): Promise<ConnectResult>;
    waitForLogin(
        handle: LoginHandle,
        onStatus: (status: LoginStatus) => void,
    ): Promise<string | null>;
    getSessionSigner(): Promise<SessionHandle | null>;
    findSession(): Promise<LogoutHandle | null>;
    waitForLogout(handle: LogoutHandle, onStatus: (status: LogoutStatus) => void): Promise<void>;
    requestAllocation(
        session: SessionHandle,
        resources?: AllocatableResource[],
    ): Promise<AllocationOutcome[]>;
    clearLocalAppStorage(appsDir?: string): Promise<void>;
}

/** Build an auth client for one product's `AuthConfig`. */
export function createAuthClient(config: AuthConfig): AuthClient {
    const ref = { productId: config.productId, derivationIndex: config.derivationIndex };
    const storageDir = config.storageDir ?? defaultStorageDir(config.dappId);

    // The adapter acts as `productId`, so its helpers' default product is the
    // one this client signs and allocates for. The session is kept per `dappId`.
    function createAdapter(): Promise<TerminalAdapter> {
        return createTerminalAdapter({
            appId: config.productId,
            network: config.network,
            storageDir,
            approvals: config.approvals,
        });
    }

    async function deriveSessionAddresses(
        adapter: TerminalAdapter,
        session: TerminalSession,
        knownPublicKey?: Uint8Array,
    ): Promise<SessionAddresses> {
        const productPublicKey = knownPublicKey ?? (await deriveProductPublicKey(adapter, ref));
        return {
            rootAddress: ss58Encode(sessionRootPublicKey(session)),
            productAddress: ss58Encode(productPublicKey),
            productH160: deriveH160(productPublicKey),
        };
    }

    async function connect(): Promise<ConnectResult> {
        const adapter = await createAdapter();
        if (adapter.session) {
            try {
                const addresses = await deriveSessionAddresses(adapter, adapter.session);
                return { kind: "existing", address: addresses.productAddress, addresses };
            } finally {
                destroyQuietly(adapter);
            }
        }

        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            let showDeeplink: (deeplink: string) => void = () => {};
            const deeplink = new Promise<string>((resolve) => {
                showDeeplink = resolve;
            });
            const session = adapter.login({ onPairing: showDeeplink });
            // Until waitForLogin takes it over, a failed login must not surface as unhandled.
            session.catch(() => {});
            const qrCode = await Promise.race([
                deeplink.then(renderQrCode),
                session.then(() => {
                    throw new Error("Login finished without showing a QR code");
                }),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `No pairing QR within ${QR_TIMEOUT_MS / 1000}s, try again`,
                                ),
                            ),
                        QR_TIMEOUT_MS,
                    );
                }),
            ]);
            return { kind: "qr", qrCode, login: { adapter, session } };
        } catch (error) {
            destroyQuietly(adapter);
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function waitForLogin(
        { adapter, session }: LoginHandle,
        onStatus: (status: LoginStatus) => void,
    ): Promise<string | null> {
        const stop = adapter.onAuthStateChange((state) => {
            if (state.tag === "Authenticating") onStatus({ step: "paired" });
        });
        try {
            onStatus({ step: "waiting" });
            const addresses = await deriveSessionAddresses(adapter, await session);
            onStatus({ step: "success", address: addresses.productAddress, addresses });
            return addresses.productAddress;
        } catch (error) {
            onStatus({
                step: "error",
                message: error instanceof Error ? error.message : String(error),
            });
            return null;
        } finally {
            stop();
            destroyQuietly(adapter);
        }
    }

    async function getSessionSigner(): Promise<SessionHandle | null> {
        const adapter = await createAdapter();
        const session = adapter.session;
        if (!session) {
            destroyQuietly(adapter);
            return null;
        }
        try {
            const publicKey = await deriveProductPublicKey(adapter, ref);
            const signer = await createSessionSigner(adapter, { ...ref, publicKey });
            const addresses = await deriveSessionAddresses(adapter, session, publicKey);
            let destroyed = false;
            return {
                address: addresses.productAddress,
                addresses,
                signer,
                adapter,
                session,
                destroy() {
                    if (destroyed) return;
                    destroyed = true;
                    destroyQuietly(adapter);
                },
            };
        } catch (error) {
            destroyQuietly(adapter);
            throw error;
        }
    }

    function requestAllocation(
        { adapter }: SessionHandle,
        resources: AllocatableResource[] = DEFAULT_RESOURCES,
    ): Promise<AllocationOutcome[]> {
        return requestResourceAllocation(adapter, config.productId, resources);
    }

    async function findSession(): Promise<LogoutHandle | null> {
        const adapter = await createAdapter();
        const session = adapter.session;
        if (!session) {
            destroyQuietly(adapter);
            return null;
        }
        const address = await deriveSessionAddresses(adapter, session).then(
            (addresses) => addresses.productAddress,
            () => ss58Encode(sessionRootPublicKey(session)),
        );
        return { adapter, address };
    }

    /** Disconnect the session, telling the paired wallet when it can be reached, then clear local state. */
    async function waitForLogout(
        { adapter, address }: LogoutHandle,
        onStatus: (status: LogoutStatus) => void,
    ): Promise<void> {
        let reason: string | undefined;
        try {
            onStatus({ step: "disconnecting", address });
            await adapter.logout();
        } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
        } finally {
            await adapter.destroy().catch(() => {});
        }
        try {
            await clearLocalAppStorage();
            onStatus(reason ? { step: "partial", address, reason } : { step: "success", address });
        } catch (error) {
            onStatus({
                step: "error",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Remove this client's stored session: the `core/` and `product/` folders
     * in its storage directory, and any `${dappId}_*` session files in `appsDir`.
     * Nothing else in either directory is touched.
     */
    async function clearLocalAppStorage(
        appsDir: string = join(homedir(), ".polkadot-apps"),
    ): Promise<void> {
        await Promise.all(
            ["core", "product"].map((dir) =>
                rm(join(storageDir, dir), { recursive: true, force: true }),
            ),
        );
        let entries: Dirent[];
        try {
            entries = await readdir(appsDir, { withFileTypes: true });
        } catch {
            return;
        }
        const legacyPrefix = `${config.dappId}_`;
        await Promise.all(
            entries
                .filter((entry) => entry.isFile() && entry.name.startsWith(legacyPrefix))
                .map((entry) => unlink(join(appsDir, entry.name)).catch(() => {})),
        );
    }

    return {
        connect,
        waitForLogin,
        getSessionSigner,
        findSession,
        waitForLogout,
        requestAllocation,
        clearLocalAppStorage,
    };
}
