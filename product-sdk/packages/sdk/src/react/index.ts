/**
 * @parity/product-sdk/react
 *
 * React bindings for the Product SDK.
 * Provides hooks and components for wallet connection, storage, and chain interaction.
 *
 * @example
 * ```tsx
 * import { ProductSDKProvider, useWallet, useLocalStorage } from '@parity/product-sdk/react';
 *
 * function App() {
 *   return (
 *     <ProductSDKProvider name="my-app">
 *       <MyApp />
 *     </ProductSDKProvider>
 *   );
 * }
 *
 * function MyApp() {
 *   const { isConnected, connect, accounts } = useWallet();
 *   const [theme, setTheme] = useLocalStorage('theme', 'light');
 *
 *   // ...
 * }
 * ```
 */

// Provider
export { ProductSDKProvider } from "./provider.js";
export type { ProductSDKProviderProps } from "./provider.js";

// Context
export { ProductSDKContext, useProductSDK } from "./context.js";

// Hooks
export { useWallet } from "./useWallet.js";
export type { UseWalletState, UseWalletActions, UseWalletReturn } from "./useWallet.js";

export { useLocalStorage, useLocalStorageString } from "./useLocalStorage.js";

export { useChain } from "./useChain.js";
