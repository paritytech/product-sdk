// Typed contract calls.
//
// ContractManager reads a CDM manifest (`cdm.json` — ABI + address +
// chain RPCs) and returns a typed contract surface. Queries are
// dry-runs; `.tx` methods produce signed extrinsics via SignerManager.
//
// Per-app step: deploy your contract to Asset Hub (EVM) and drop the
// resulting `cdm.json` into `src/lib/`, then uncomment the wiring below.
//
//   import cdm from "./cdm.json";
//   const chain = await getChain();
//   return ContractManager.fromClient(cdm as any, chain.raw.assetHub, { signerManager });
//
// Usage from a component (once wired):
//   const registry = await getRegistry();
//   const contract = registry.get("@my-app/my-contract");
//   const owner = await contract.owner.query();
//   await contract.someMethod.tx(arg1, { signer });
//
// Reference: `contracts-demo` in the @parity/product-sdk repo.

import { ContractManager } from "@parity/product-sdk-contracts";
import { signerManager } from "./auth";
import { getChain } from "./chain";

export async function getRegistry(): Promise<ContractManager> {
  await getChain();
  void signerManager;
  throw new Error(
    "registry.ts: drop a cdm.json (ABI + address + RPCs) into src/lib/ " +
      "and uncomment the ContractManager.fromClient(...) wiring above.",
  );
}
