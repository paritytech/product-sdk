---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

**`getCredits(chain, { claimant })`: every NFT claim credit one claimant holds, with where each stands.**

A credit is awarded on the People chain and spent on Asset Hub, so this is the first read here that
spans two chains. It takes `NftsChain & NftsCreditsChain`, the new contract for the People side plus
the two `NftClaims` entries on Asset Hub, and a client from `getChainAPI(...)` satisfies both at
once. Two blocks are pinned, one per chain, and both come back in `at`.

```ts
const result = await getCredits(chain, { claimant: { tag: "Account", address } });
// -> { at: { individuality, assetHub }, credits: [{ hash, awardBlock, awardedAt, gameIndex, leafIndex, state }] }
```

`state` is one of four. `earned` means the award block has no root on Asset Hub yet, so a claim
would be refused. `claimable` means the root arrived and the leaf is unspent. `claimed` means the
leaf is spent. `unprovable` means the awards were pruned before the proofs were read, so the credit
exists but this read cannot produce the leaf index a claim needs. That last case is reported rather than
dropped, because a shelf that silently loses old credits is worse than one that says why.

A claimant is `{ tag: "Account", address }` or `{ tag: "Person", alias }`. The pallet keys the two
apart and nothing links them, so a player who moved from account to alias has to be read twice.

Six new descriptor entries for apps that prune their own: `NftCredits.NftClaimCreditBlocks`,
`NftCredits.NftClaimCreditAwards`, the runtime APIs `NftCreditsApi.nft_claim_credit_roots` and
`nft_claim_credit_proofs` on the People chain, and `NftClaims.CreditTrees` and
`NftClaims.ClaimedLeaves` on Asset Hub.
