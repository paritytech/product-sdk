// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SignerError } from "../errors.js";
import type { ConnectionStatus, ProviderType, Result, SignerAccount } from "../types.js";

/** Function that unsubscribes a listener when called. */
export type Unsubscribe = () => void;

/**
 * Interface that all signer providers must implement.
 *
 * Providers are responsible for discovering accounts and creating signers
 * from a specific source (Host API or dev accounts).
 */
export interface SignerProvider {
    /** Unique identifier for this provider type. */
    readonly type: ProviderType;

    /**
     * Attempt to connect and discover accounts.
     *
     * @param signal - Optional AbortSignal to cancel the connection attempt.
     * @returns Accounts on success, typed error on failure.
     */
    connect(signal?: AbortSignal): Promise<Result<SignerAccount[], SignerError>>;

    /**
     * Disconnect and clean up resources.
     * Safe to call multiple times.
     */
    disconnect(): void;

    /**
     * Subscribe to connection status changes.
     *
     * Not all providers emit status changes — for example, dev accounts
     * are always "connected" and never emit.
     *
     * @returns Unsubscribe function.
     */
    onStatusChange(callback: (status: ConnectionStatus) => void): Unsubscribe;

    /**
     * Subscribe to account list changes.
     *
     * Emitted when the set of available accounts changes (e.g., user
     * connects/disconnects in the host wallet).
     *
     * @returns Unsubscribe function.
     */
    onAccountsChange(callback: (accounts: SignerAccount[]) => void): Unsubscribe;
}
