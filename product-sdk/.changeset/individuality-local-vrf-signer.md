---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Mint airdrop VRFs without a host: `localAirdropVrfSigner` in a new `testing` subpath.**

`localAirdropVrfSigner(secretKey)` from `@parity/product-sdk-individuality/testing` is an `AirdropVrfSigner` over an sr25519 secret key held in memory, so a script can call `mintAccountAirdropVrfs` and sign up for the game with no host. It signs the transcript the airdrop pallet verifies, which `vrf.sign` from `@scure/sr25519` cannot express, and refuses a transcript whose `signer` item names another key. Its signatures are pinned against the VRF of `@scure/sr25519` on the one transcript both can express.

It is for development only and never ships from the main entry. A hosted product keeps signing through the host. `@parity/product-sdk/testing` re-exports it.

The package now depends on `@noble/curves` and `@scure/sr25519`, which only the `testing` entry imports.
