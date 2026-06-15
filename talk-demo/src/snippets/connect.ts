import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { app } from "../sdk";

// Connect to Asset Hub through the host and watch new (best) blocks as they arrive.
export async function watchBlocks(
  onBlock: (info: { number: number; hash: string }) => void,
  onError: (err: Error) => void,
) {
  const { assetHub } = await app.chain.connect({ assetHub: paseo_asset_hub });
  return assetHub.query.System.Number.watchValue({ at: "best" }).subscribe({
    next: ({ block, value }) => onBlock({ number: value, hash: block.hash }),
    error: onError,
  });
}
