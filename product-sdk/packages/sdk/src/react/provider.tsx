// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * ProductSDKProvider component
 */

import React, { useEffect, useState, type ReactNode } from "react";
import { ProductSDKContext } from "./context.js";
import { createApp } from "../core/createApp.js";
import type { App, LogLevel } from "../core/types.js";

/** Props for ProductSDKProvider */
export interface ProductSDKProviderProps {
    /** Application name - used for storage namespacing and product account derivation */
    name: string;
    /** Log level (default: 'info') */
    logLevel?: LogLevel;
    /** Child components */
    children: ReactNode;
    /** Fallback to show while loading */
    fallback?: ReactNode;
}

/**
 * Provider component that initializes the Product SDK
 *
 * @example
 * ```tsx
 * import { ProductSDKProvider } from '@parity/product-sdk/react';
 *
 * function App() {
 *   return (
 *     <ProductSDKProvider name="my-app" fallback={<Loading />}>
 *       <MyApp />
 *     </ProductSDKProvider>
 *   );
 * }
 * ```
 */
export function ProductSDKProvider({
    name,
    logLevel = "info",
    children,
    fallback = null,
}: ProductSDKProviderProps) {
    const [app, setApp] = useState<App | null>(null);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        let mounted = true;

        createApp({ name, logLevel })
            .then((createdApp) => {
                if (mounted) {
                    setApp(createdApp);
                }
            })
            .catch((e) => {
                if (mounted) {
                    setError(e instanceof Error ? e : new Error(String(e)));
                }
            });

        return () => {
            mounted = false;
        };
    }, [name, logLevel]);

    if (error) {
        throw error;
    }

    if (!app) {
        return <>{fallback}</>;
    }

    return <ProductSDKContext.Provider value={app}>{children}</ProductSDKContext.Provider>;
}
