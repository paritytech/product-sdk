---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Person-origin signing follows the pipeline the hosts encode, and the game's prize draws are open to recognized players.** Both are People runtime 3004000.

The runtime now declares two transaction-extension pipelines: version 0, the plain one a signed V4 extrinsic rides, and version 1, which carries `AsPerson`, `ScoreAsParticipant`, `PeopleLiteAuth` and the rest of the origin extensions. `readExtensionPipeline` used to refuse any blob that declared more than one version, so every `withAsPerson`, `withScoreParticipant`, `withLiteAlias` and `buildLiteAliasBindTx` call threw against the live chains. It now reads the highest declared version, the rule the Rust host core encodes with, and the signer wrappers fill the slots PAPI 2.x leaves out (it only knows version 0) with the chain's own defaults before hashing the implication. The pinned lite-bind extrinsic opens with extension version 1 and carries `CheckMetadataHash`.

`AirdropVrfs::Alias` is buildable: the chain verifies each draw proof in the product context `product/<product_name>.<tld>/<event_id>` (`Game.product_name` is `dim2`), which is what a host mints for `createRingVRFProof(peopleKey, { productId, suffix: Raw(eventId) }, peopleRing(genesis), message)`. New `mintAliasAirdropVrfs(signer, { eventIds, registrant, productId })` returns `{ proofs, ringIndex, revision }`, signing the registration entry (`1u8 ++ account_id` or `0u8 ++ alias`), checking the returned context against the one derived offline, and refusing proofs that disagree on the ring revision. `signUpWithAccountTx` and `signUpWithLiteInviteTx` take that value in `airdrops` beside the account VRFs.

Breaking: the `AliasVrfsUnavailable` blocker is gone. A recognized player now reads `canEnterDraws: true` with `variant: "Alias"`; whether the calling product may use the People member key is the host's grant decision and surfaces from the mint, not from the requirement read. `NotSr25519` applies to the `Account` variant only.
