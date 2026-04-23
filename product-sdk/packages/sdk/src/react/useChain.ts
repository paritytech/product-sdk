/**
 * useChain hook
 */

import { useMemo } from "react";
import { useProductSDK } from "./context.js";
import type { ChainDefinition, TypedApi } from "../core/types.js";

/**
 * Hook to get a typed chain client
 *
 * @param chain - Chain descriptor (PAPI ChainDefinition)
 *
 * @example
 * ```tsx
 * import { paseo_asset_hub } from '@parity/product-sdk-descriptors/paseo-asset-hub';
 * import { useChain } from '@parity/product-sdk/react';
 *
 * function AssetHubBalance() {
 *   const assetHub = useChain(paseo_asset_hub);
 *
 *   // assetHub is typed for Asset Hub queries
 *   const balance = await assetHub.query.System.Account.getValue(address);
 * }
 * ```
 */
export function useChain<T extends ChainDefinition>(chain: T): TypedApi<T> {
    const app = useProductSDK();

    return useMemo(() => {
        return app.chain.getClient(chain);
    }, [app, chain]);
}
