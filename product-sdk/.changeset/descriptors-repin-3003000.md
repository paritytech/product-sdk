---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk": minor
---

**Re-pin the Paseo Asset Hub and Paseo individuality descriptors against the live 3003000 runtimes.**

Both chains upgraded, so the bundled metadata no longer matched them. The genesis hashes are
unchanged, so connections keep working. What changed is what the descriptors can decode.

Two changes break direct descriptor users, and neither affects a caller that goes through
`@parity/product-sdk-nfts`, which was updated in the same release.

`NftCredits.NftClaimCreditAwards` on the People chain is now keyed `(block, chunk)` rather than
by block, with at most `CHUNKS_PER_TREE` chunks a block. A read by block alone no longer
compiles.

`NftClaims.ClaimedCredits` on Asset Hub is gone. Its replacement is `NftClaims.ClaimedLeaves`,
one bitmap per tree block with bit `leaf_index` set for each claimed leaf, least significant bit
first. The bitmap outlives the tree, so a claim still reads as claimed after the tree is swept.

New in the Asset Hub descriptor and read by the nfts package: `NftClaimsApi.preview_mints`.
