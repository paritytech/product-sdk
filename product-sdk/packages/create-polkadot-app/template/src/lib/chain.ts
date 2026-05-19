// Chain client singleton.
//
// `getChainAPI("paseo")` returns a `ChainClient` you can share across
// the app. The first call opens a WebSocket; subsequent calls reuse it.
// Call `destroyAll()` from @parity/product-sdk-chain-client on teardown
// to close open connections.
//
// Usage:
//   import { getChain } from "./lib/chain";
//   const chain = await getChain();
//   const block = await chain.assetHub.query.System.Number.getValue();
//
// Reference: `@parity/product-sdk-chain-client` README + the demo apps.

import { getChainAPI } from "@parity/product-sdk-chain-client";
import type { ChainClient, PresetChains } from "@parity/product-sdk-chain-client";

let clientPromise: Promise<ChainClient<PresetChains<"paseo">>> | null = null;

export async function getChain() {
  if (!clientPromise) clientPromise = getChainAPI("paseo");
  return clientPromise;
}
