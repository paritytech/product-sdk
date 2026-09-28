---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk": minor
---

**Re-pin `paseo-individuality` and `previewnet-individuality` to spec 3003000 (#242).**

Both chains now pin codeHash `0x90d0e268…43744`. Previewnet was also re-genesised, from `0xf720c28f…35218` to `0x55e3e689…249e9`, so the previous descriptor fails to connect to it with `GenesisMismatchError`. Paseo keeps genesis `0x4a2b5b73…5ad48`.

**Minor rather than patch, because surface is removed.** Both chains changed the same way.

| Kind | Removed | Added |
| --- | --- | --- |
| Storage | `NftCredits.NftClaimCreditAwardBlocks`, `NftCredits.PendingNftClaimCreditRootInfo` | `NftCredits.CreditBuffers`, `NftCredits.CreditBufferCursor`, `NftCredits.RetainedCreditTreeBlocks`, `NftCredits.RootExpiries`, `Coinage.RecyclersUnloadedCount` |
| Constants | `NftCredits.MaxCreditsPerBlock`, `NftCredits.MaxRetainedAwardBlocks`, `Coinage.MaxFreeUnloadTokensPerTimePeriod`, `Coinage.UnloadTokenAllowancePerTimePeriodForLitePeople`, `Coinage.UnloadTokenAllowancePerTimePeriodForPeople` | `NftCredits.ClaimsChainTreeTtl`, `NftCredits.MaxRetainedCreditTrees`, `NftCredits.MaxRootsPerSweep`, `NftCredits.MaxTreeDeletionsPerMessage` |
| Calls | none | `NftCredits.receive_tree_deletions`, `NftCredits.sweep_expired_roots`, `Score.force_set_attendance` |

`NftCredits.NftClaimCreditAwards` keeps its name but is now keyed by block and chunk index rather than by block alone, so a read written against the old key no longer typechecks. The `NftCreditsApi` runtime APIs answer the same questions and also serve the Merkle proof a claim needs.

`@parity/product-sdk-chain-client` needs no entry. It reads `.genesis` off the imported descriptor, so only its in-source test restated the previewnet hash.
