---
"@parity/product-sdk-nfts": patch
---

`getClaims` no longer reports a minted credit as `earned` once its tree is finished. The People chain drops a tree's root when the claims chain has finished with it, every leaf spent or past its deadline, and keeps the awards a while longer; until now the awards of such a block came back as credits `earned` again, with no time and no proof, and a wallet showed a minted credit as one still to mint. A rootless award block more than 16 People blocks behind the head is now read against the Asset Hub `ClaimedLeaves` bitmap: a spent leaf is `claimed`, with its leaf index, and the rest of the block is one `unprovable` entry, as a pruned block is.
