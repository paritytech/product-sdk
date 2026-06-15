import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { getApp } from "../sdk";

// Connect to Asset Hub through the host and watch new blocks as they arrive.
export async function watchBlocks(onBlock: (block: number) => void) {
  const app = await getApp();
  const { assetHub } = await app.chain.connect({ assetHub: paseo_asset_hub });
  return assetHub.query.System.Number.watchValue({ at: "best" }).subscribe(
    ({ value }) => onBlock(value),
  );
}
