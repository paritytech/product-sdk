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
 * QR login flow — pure business logic, no UI. Lifted from playground-cli
 * `src/utils/auth.ts` (issue #411); the env-specific config playground imported
 * from its `config.ts` is now injected via `createAuthClient(config)`.
 *
 * Flow:
 *   1. `connect()` — starts adapter + auth, returns existing address OR QR code
 *   2. Print QR code to stdout (if needed) — before any UI mounts
 *   3. `waitForLogin()` — awaits the already-running auth to complete
 *   4. `getSessionSigner()` — gets a working signer for tx signing (separate adapter)
 *   5. `requestAllocation()` — RFC-0010 resource allocation (needed before a fresh session can sign)
 *   6. `findSession()` / `waitForLogout()` — sign out flow, mirror image of connect/waitForLogin
 */

import type { Dirent } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveH160, ss58Encode } from "@parity/product-sdk-address";
import {
    createTerminalAdapter,
    waitForSessions,
    renderQrCode,
    type TerminalAdapter,
    type PairingStatus,
    type UserSession,
} from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";
import { createSessionSigner, deriveProductPublicKey, sessionRootPublicKey } from "./sessionSigner.js";
import {
    requestResourceAllocation,
    DEFAULT_RESOURCES,
    type AllocatableResource,
    type AllocationOutcome,
    type OnExistingAllowancePolicy,
} from "./allocations.js";
import type { AuthConfig } from "./types.js";

/** How long we wait for the statement store to publish the pairing QR. */
const QR_TIMEOUT_MS = 60_000;

/**
 * The three addresses we surface from a paired session.
 *
 * - `rootAddress` — SS58 of `session.rootAccountId`, the `rootUserAccountId`
 *   the mobile app sent over the SSO handshake (bare-mnemonic sr25519 root on
 *   current mobile builds). Keyed by `Resources.Consumers` on the People
 *   parachain, so it's the right input for `lookupUsername`.
 * - `productAddress` — SS58 of the product account derived via
 *   `product/{productId}/{index}` from `rootAccountId`. This is what actually
 *   signs on-chain transactions from the CLI.
 * - `productH160` — the same product pubkey as a 20-byte EVM address (Revive /
 *   contracts view). Derived from the SAME pubkey as `productAddress`.
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
    | { step: "pending"; stage: string }
    | { step: "success"; address: string; addresses: SessionAddresses }
    | { step: "error"; message: string };

export interface LoginHandle {
    adapter: TerminalAdapter;
    /** The authenticate() promise — already running since connect(). */
    authPromise: ReturnType<TerminalAdapter["sso"]["authenticate"]>;
}

/**
 * A session signer bundle — the signer plus an explicit `destroy()` that tears
 * down the long-lived adapter the signer depends on. Callers MUST invoke
 * `destroy()` once done — the WebSocket keeps the event loop alive.
 */
export interface SessionHandle {
    address: string;
    addresses: SessionAddresses;
    signer: PolkadotSigner;
    userSession: UserSession;
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
    session: UserSession;
}

/** The product-bound auth surface returned by `createAuthClient`. */
export interface AuthClient {
    connect(): Promise<ConnectResult>;
    waitForLogin(handle: LoginHandle, onStatus: (status: LoginStatus) => void): Promise<string | null>;
    getSessionSigner(): Promise<SessionHandle | null>;
    findSession(): Promise<LogoutHandle | null>;
    waitForLogout(handle: LogoutHandle, onStatus: (status: LogoutStatus) => void): Promise<void>;
    requestAllocation(
        session: UserSession,
        resources?: AllocatableResource[],
        onExisting?: OnExistingAllowancePolicy,
    ): Promise<AllocationOutcome[]>;
    clearLocalAppStorage(dir?: string): Promise<void>;
}

/**
 * Build an auth client bound to a product's `AuthConfig`. All adapter creation,
 * address derivation, and session-storage scoping read from `config`, so the
 * same code serves any product.
 */
export function createAuthClient(config: AuthConfig): AuthClient {
    const ref = { productId: config.productId, derivationIndex: config.derivationIndex };

    function createAdapter(): TerminalAdapter {
        return createTerminalAdapter({
            appId: config.dappId,
            metadataUrl: config.metadataUrl,
            endpoints: config.peopleEndpoints,
        });
    }

    /**
     * Compute the three display addresses from a paired session. Shares
     * `deriveProductPublicKey` with `createSessionSigner` so the signing key and
     * the display SS58/H160 are computed by exactly one function.
     */
    function deriveSessionAddresses(session: UserSession): SessionAddresses {
        const rootBytes = sessionRootPublicKey(session);
        const productPubkey = deriveProductPublicKey(rootBytes, ref);
        return {
            rootAddress: ss58Encode(rootBytes),
            productAddress: ss58Encode(productPubkey),
            productH160: deriveH160(productPubkey),
        };
    }

    function createSigner(session: UserSession): PolkadotSigner {
        return createSessionSigner(session, ref);
    }

    function sessionRemoteAddress(session: UserSession): string | null {
        const raw = (session as { remoteAccount?: { accountId?: Uint8Array } }).remoteAccount?.accountId;
        const accountId = raw ? new Uint8Array(raw) : new Uint8Array();
        return accountId.length === 32 ? ss58Encode(accountId) : null;
    }

    function sessionLogoutAddress(session: UserSession): string {
        try {
            return deriveSessionAddresses(session).productAddress;
        } catch {
            return sessionRemoteAddress(session) ?? "(stored session)";
        }
    }

    /**
     * Connect to the statement store and resolve the login state. Returns
     * immediately if an existing session is found (address only). Otherwise
     * kicks off authenticate(), waits for the QR payload, and returns the QR
     * code + a handle to await the auth result.
     */
    async function connect(): Promise<ConnectResult> {
        const adapter = createAdapter();

        const sessions = await waitForSessions(adapter);
        if (sessions.length > 0) {
            const addresses = deriveSessionAddresses(sessions[0]);
            return { kind: "existing", address: addresses.productAddress, addresses };
        }

        // Start authenticate — this triggers the pairing flow and QR emission.
        const authPromise = adapter.sso.authenticate();

        try {
            const qrCode = await Promise.race([
                new Promise<string>((resolve) => {
                    let done = false;
                    let unsub: (() => void) | undefined;
                    unsub = adapter.sso.pairingStatus.subscribe(async (status: PairingStatus) => {
                        if (status.step === "pairing" && !done) {
                            done = true;
                            unsub?.();
                            resolve(await renderQrCode(status.payload));
                        }
                    });
                }),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Login service did not respond within ${Math.round(
                                        QR_TIMEOUT_MS / 1000,
                                    )}s — try again`,
                                ),
                            ),
                        QR_TIMEOUT_MS,
                    ),
                ),
            ]);

            return { kind: "qr", qrCode, login: { adapter, authPromise } };
        } catch (err) {
            // Release the WebSocket so we don't leak on the error path. `.catch()`
            // swallows the post-destroy `DestroyedError` that polkadot-api's
            // raw-client surfaces when a pending chainHead unsubscribe races the
            // WS close.
            adapter.destroy().catch(() => {});
            throw err;
        }
    }

    /**
     * Wait for the already-running login to complete. Call after the QR code is
     * displayed. Reports status via callback. Returns the SS58 address on
     * success, or null on failure.
     */
    async function waitForLogin(
        { adapter, authPromise }: LoginHandle,
        onStatus: (status: LoginStatus) => void,
    ): Promise<string | null> {
        onStatus({ step: "waiting" });

        const unsubPairing = adapter.sso.pairingStatus.subscribe((status: PairingStatus) => {
            if (status.step === "finished") {
                onStatus({ step: "paired" });
            } else if (status.step === "pending") {
                onStatus({ step: "pending", stage: status.stage });
            } else if (status.step === "pairingError") {
                onStatus({ step: "error", message: status.message });
            }
        });

        let authenticated = false;
        let address: string | null = null;
        try {
            const result = await authPromise;
            result.match(
                (session) => {
                    if (session) {
                        authenticated = true;
                    }
                },
                (error) => {
                    onStatus({ step: "error", message: error.message });
                },
            );
            if (authenticated) {
                const sessions = await waitForSessions(adapter, 3000);
                if (sessions.length > 0) {
                    const addresses = deriveSessionAddresses(sessions[0]);
                    address = addresses.productAddress;
                    onStatus({ step: "success", address, addresses });
                } else {
                    onStatus({
                        step: "error",
                        message: "Login succeeded but the local session was not available",
                    });
                }
            }
        } finally {
            unsubPairing();
        }

        return address;
    }

    /**
     * Get a working signer from a persisted session. The returned handle owns a
     * terminal adapter that stays alive while the signer is in use (signing goes
     * through the adapter's WebSocket). Call `destroy()` when done. Returns null
     * if no session exists.
     */
    async function getSessionSigner(): Promise<SessionHandle | null> {
        const adapter = createAdapter();

        const sessions = await waitForSessions(adapter, 3000);
        if (sessions.length === 0) {
            adapter.destroy().catch(() => {});
            return null;
        }

        const session = sessions[0];
        const signer = createSigner(session);
        const addresses = deriveSessionAddresses(session);

        let destroyed = false;
        const destroy = () => {
            if (destroyed) return;
            destroyed = true;
            adapter.destroy().catch(() => {});
        };

        return {
            address: addresses.productAddress,
            addresses,
            signer,
            userSession: session,
            destroy,
        };
    }

    /**
     * RFC-0010 resource allocation over the user's active session — grants the
     * statement-store / Bulletin / smart-contract allowances the product account
     * needs before it can sign. The mobile wallet prompts the user to approve.
     */
    async function requestAllocation(
        session: UserSession,
        resources: AllocatableResource[] = DEFAULT_RESOURCES,
        onExisting: OnExistingAllowancePolicy = "Ignore",
    ): Promise<AllocationOutcome[]> {
        return requestResourceAllocation(session, config.productId, resources, onExisting);
    }

    /**
     * Look up the currently paired session, if any. Returns a handle ready for
     * `waitForLogout()`, or null when no session is signed in (adapter destroyed
     * on the null path).
     */
    async function findSession(): Promise<LogoutHandle | null> {
        const adapter = createAdapter();
        const sessions = await waitForSessions(adapter, 3000);
        if (sessions.length === 0) {
            try {
                await adapter.destroy();
            } catch {
                // best-effort
            }
            return null;
        }
        const session = sessions[0];
        const address = sessionLogoutAddress(session);
        return { adapter, address, session };
    }

    /**
     * Disconnect the given session. Sends a `Disconnected` statement so the
     * paired mobile app drops its side, then clears the local `${dappId}_*`
     * files. Always releases the adapter before returning.
     */
    async function waitForLogout(
        handle: LogoutHandle,
        onStatus: (status: LogoutStatus) => void,
    ): Promise<void> {
        const { adapter, address, session } = handle;

        try {
            onStatus({ step: "disconnecting", address });
            const result = await adapter.sessions.disconnect(session);
            if (result.isOk()) {
                await clearLocalAppStorage();
                onStatus({ step: "success", address });
                return;
            }
            const reason = result.error.message || "remote unreachable";
            await clearLocalAppStorage();
            onStatus({ step: "partial", address, reason });
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            try {
                await clearLocalAppStorage();
                onStatus({ step: "partial", address, reason });
            } catch (cleanupErr) {
                const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                onStatus({ step: "error", message: msg });
            }
        } finally {
            try {
                await adapter.destroy();
            } catch {
                // best-effort
            }
        }
    }

    /**
     * Best-effort removal of this app's persisted state under `~/.polkadot-apps/`.
     * Scoped by `${dappId}_` prefix so files belonging to other polkadot apps
     * sharing the directory are left alone. Errors are swallowed.
     */
    async function clearLocalAppStorage(
        dir: string = join(homedir(), ".polkadot-apps"),
    ): Promise<void> {
        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        const prefix = `${config.dappId}_`;
        await Promise.all(
            entries
                .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
                .map((entry) =>
                    unlink(join(dir, entry.name)).catch(() => {
                        // best-effort
                    }),
                ),
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
