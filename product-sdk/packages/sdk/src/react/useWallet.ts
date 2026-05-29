// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * useWallet hook
 */

import { useState, useEffect, useCallback } from "react";
import { useProductSDK } from "./context.js";
import type { Account } from "../core/types.js";

/** Wallet hook state */
export interface UseWalletState {
    /** Whether wallet is connected */
    isConnected: boolean;
    /** Whether connection is in progress */
    isConnecting: boolean;
    /** Available accounts */
    accounts: Account[];
    /** Currently selected account */
    selectedAccount: Account | null;
    /** Last error */
    error: Error | null;
}

/** Wallet hook actions */
export interface UseWalletActions {
    /** Connect to wallet */
    connect: () => Promise<void>;
    /** Disconnect from wallet */
    disconnect: () => Promise<void>;
    /** Select an account */
    selectAccount: (address: string) => void;
    /** Sign a message */
    signMessage: (message: string | Uint8Array) => Promise<Uint8Array>;
}

/** Return type of useWallet */
export type UseWalletReturn = UseWalletState & UseWalletActions;

/**
 * Hook for wallet connection and signing
 *
 * @example
 * ```tsx
 * function WalletButton() {
 *   const { isConnected, accounts, connect, disconnect, selectAccount } = useWallet();
 *
 *   if (!isConnected) {
 *     return <button onClick={connect}>Connect Wallet</button>;
 *   }
 *
 *   return (
 *     <div>
 *       <select onChange={(e) => selectAccount(e.target.value)}>
 *         {accounts.map((a) => (
 *           <option key={a.address} value={a.address}>
 *             {a.name || a.address}
 *           </option>
 *         ))}
 *       </select>
 *       <button onClick={disconnect}>Disconnect</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useWallet(): UseWalletReturn {
    const app = useProductSDK();

    const [state, setState] = useState<UseWalletState>({
        isConnected: false,
        isConnecting: false,
        accounts: [],
        selectedAccount: null,
        error: null,
    });

    const connect = useCallback(async () => {
        setState((s) => ({ ...s, isConnecting: true, error: null }));
        try {
            const result = await app.wallet.connect();
            setState((s) => ({
                ...s,
                isConnected: true,
                isConnecting: false,
                accounts: result.accounts,
                selectedAccount: result.accounts[0] || null,
            }));
        } catch (e) {
            setState((s) => ({
                ...s,
                isConnecting: false,
                error: e instanceof Error ? e : new Error(String(e)),
            }));
        }
    }, [app]);

    const disconnect = useCallback(async () => {
        await app.wallet.disconnect();
        setState({
            isConnected: false,
            isConnecting: false,
            accounts: [],
            selectedAccount: null,
            error: null,
        });
    }, [app]);

    const selectAccount = useCallback(
        (address: string) => {
            app.wallet.selectAccount(address);
            const account = state.accounts.find((a) => a.address === address) || null;
            setState((s) => ({ ...s, selectedAccount: account }));
        },
        [app, state.accounts],
    );

    const signMessage = useCallback(
        async (message: string | Uint8Array) => {
            return app.wallet.signMessage(message);
        },
        [app],
    );

    // Subscribe to account changes
    useEffect(() => {
        const unsubscribe = app.wallet.onAccountChange((account) => {
            setState((s) => ({ ...s, selectedAccount: account }));
        });
        return unsubscribe;
    }, [app]);

    return {
        ...state,
        connect,
        disconnect,
        selectAccount,
        signMessage,
    };
}
