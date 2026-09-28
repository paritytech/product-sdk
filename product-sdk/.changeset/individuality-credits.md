---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Hash an NFT claim credit offline: `creditHash`.**

`creditHash({ gameIndex, round, attester, attestee })` returns the credit one attestation awards, the preimage the game pallet hashes, pinned against the two vectors of the pallet `nft_claim_credit_spec` test. `readCreditCandidates` uses it to name the credits a player could earn.

Reading the claims the chain has awarded, with the proof a mint needs, belongs to `@parity/product-sdk-nfts`, see #329.
