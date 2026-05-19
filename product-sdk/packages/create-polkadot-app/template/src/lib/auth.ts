// Wallet sign-in via SignerManager.
//
// SignerManager auto-detects whether your app is running inside a
// Polkadot host container (routes to HostProvider) or in a standard
// browser (routes to wallet extensions). Apps never instantiate
// HostProvider directly.
//
// Usage from a component:
//   import { signerManager } from "./lib/auth";
//   useEffect(() => signerManager.subscribe(setState), []);
//   await signerManager.connect();
//   const signer = signerManager.getSigner();
//
// Reference: `signer-demo` in the @parity/product-sdk repo.

import { SignerManager } from "@parity/product-sdk-signer";

export const signerManager = new SignerManager({
  ss58Prefix: 0,            // 0 = Paseo Asset Hub (addresses begin with "1")
  dappName: "polkadot-app",
});
