---
"@parity/product-sdk-nfts": patch
---

`getClaims` no longer reports a minted credit as `earned` once its tree is finished. The People chain drops a tree's root when the claims chain has finished with it, every leaf spent or past its deadline, and keeps the awards a while longer; until now the awards of such a block came back as credits `earned` again, with no time and no proof, and a wallet showed a minted credit as one still to mint. A rootless award block below the pinned People block is now read against the Asset Hub `ClaimedLeaves` bitmap: a spent leaf is `claimed`, with its leaf index, and the rest of the block is one `unprovable` entry, as a pruned block is. Such a `claimed` entry has `awardedAt: null` and `gameIndex: null`, because the award record holds only the claimant and the credit. A null time no longer means a block still to be rooted; use `state === "earned"` for that.
