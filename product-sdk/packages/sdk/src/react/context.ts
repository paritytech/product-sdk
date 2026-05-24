/**
 * React context for Product SDK
 */

import { createContext, useContext } from "react";
import type { App } from "../core/types.js";

/** Context for the Product SDK app instance */
export const ProductSDKContext = createContext<App | null>(null);

/**
 * Hook to access the Product SDK app instance
 *
 * @throws If used outside of ProductSDKProvider
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const app = useProductSDK();
 *   // Use app.wallet, app.localStorage, etc.
 * }
 * ```
 */
export function useProductSDK(): App {
    const app = useContext(ProductSDKContext);
    if (!app) {
        throw new Error(
            "useProductSDK must be used within a ProductSDKProvider. " +
                'Wrap your app with <ProductSDKProvider name="your-app">.',
        );
    }
    return app;
}
