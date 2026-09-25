---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Read NFT claim credits: `readCreditRoots`, `readCredits` and `creditHash`.**

`readCreditRoots` lists the credit roots a claimant holds credits under, with the game index, the time and the leaf count of each. Roots outlive the credits they commit, so this is the durable half: a game whose credits were pruned still answers here. `readCredits` reads the credits themselves with the leaf index and the Merkle proof a claim on Asset Hub needs. A block whose credits were pruned is listed in `prunedBlocks` rather than failing the read.

Both read one pinned finalized block through the `NftCreditsApi` runtime APIs, not storage. The claimant is a `PlayerKey`, so the credits of an account and of the alias the same person plays under are two reads with no link between them.

`creditHash` is the pure preimage the pallet hashes a credit from, pinned against the two vectors of the pallet `nft_claim_credit_spec` test.
