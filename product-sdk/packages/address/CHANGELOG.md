# @parity/product-sdk-address

## 0.3.0

### Minor Changes

- dde3b0d: **Moves the SDK to polkadot-api 3.** Breaking for every caller that signs.

  PAPI 3 replaced the `PolkadotSigner` with a `TxCreator`, which receives one payload holding the call, every transaction extension, the pipeline version those extensions belong to, and the runtime metadata. Every signer the SDK builds or accepts is now a `CommonSignerTxCreator` from `@polkadot-api/signers-common`: `getProductAccountSigner` and `getLegacyAccountSigner` in host, `SignerManager.getSigner`, `seedToAccount` and the key manager in keys, `createDevSigner` in tx, the session, slot-account and allowance signers in terminal, and the signers `resolveSigner` returns in auth. `submitAndWatch`, `batchSubmitAndWatch` and contract calls take it unchanged. A PAPI transaction is now submitted with `createSubmitAndWatch` or `createAndSubmit`, fees are estimated with a creator such as `getFakeTxCreator(address)`, and the transaction events `signed` and `txBestBlocksState` are now `created`, `inBestBlock` and `notInBestBlock`. The `TxEvent` type in tx follows.

  `withAsPerson`, `withLiteAlias` and `withScoreParticipant` now wrap a `TxCreator`. They fill the standard extensions with the PAPI 3 enhancers, write their origin extension, and hand the inner signer the pipeline version that carries it, so the host is told the version the proof was built for instead of inferring one. This replaces the slot filling that worked around PAPI 2 only knowing pipeline version 0. A fee estimate through a wrapper is priced as a plain account transaction and never requests a proof.

  Host exports `createHostTxCreator`, also published as the transport-free subpath `@parity/product-sdk-host/tx-creator`, which terminal uses for the paired-phone signer. The `txExtVersion` signer option is now the version used when the transaction names none.

  Terminal moves to `@novasamatech/host-papp`, `statement-store` and `storage-adapter` 0.12.0, and host to `@novasamatech/host-api-wrapper` 0.12.0, the releases built for PAPI 3. `@novasamatech/statement-store` 0.12.0 still depends on `@novasamatech/sdk-statement` 0.6.0, which pulls a private copy of polkadot-api 2 into the install. The descriptors are regenerated with the PAPI 3 CLI.

  Cloud Storage keeps working with `@parity/bulletin-sdk` 0.3.0 through a shim that maps its `signSubmitAndWatch` onto `createSubmitAndWatch`, to be removed when a PAPI 3 build ships.

  The `paseo-asset-hub` and `previewnet-asset-hub` descriptors follow `next-asset-hub-paseo` 3004000, and `previewnet-asset-hub` takes the new genesis of the reset Previewnet Asset Hub. That runtime drops the `Result` wrapper from `ScarcityApi.metadata_batch` and `NftClaimsApi.preview_mints`, which now return their list directly and reject an oversized batch at decode (128 queries for `metadata_batch`, 32 for `preview_mints` on `next-asset-hub-paseo` 3004000). `NftsChain` and `NftsInstancesChain` follow, so a hand-built chain answers those calls with a bare list. `getInstanceDisplays` no longer re-chunks on a `TooLarge` refusal, and `previewClaim` sends one `preview_mints` call per 32 collections, the bound the runtime enforces.

  Every nfts read now holds the blocks it pins until it settles, through the optional `hodlBlock` that `BlockSource` gains and a PAPI client already has. A finalized block was unpinned as soon as a newer one was finalized, so a read that spanned that moment failed inside a container with "is not pinned", because the host serves no archive methods to fall back to.

## 0.2.0

### Minor Changes

- f987fd7: **Fixes from review of the game and prize surface.**

  Two correctness fixes, both changing behaviour a caller can see.

  `readDrawRegistration` compared SS58 address strings, so the same account encoded under a
  different network prefix did not match and a player who was entered in a draw read as not
  entered. It now compares decoded public keys. Aliases keep the case-insensitive compare, since a
  32-byte alias really is hex. `addressesEqual` in `@parity/product-sdk-address` had the
  same limitation and is fixed the same way, so it now returns true for one account written
  under two prefixes and still returns false, rather than throwing, for a malformed input.

  `@parity/product-sdk-address` takes a `minor` rather than a `patch` for two reasons the repo's
  convention names: `publicKeysEqual` is new public surface, and the `addressesEqual` change is
  breaking under pre-1.0 semver, since a comparison that returned false now returns true.

  **Behaviour change worth reading if you use `addressesEqual`.** It now compares the account, not
  the encoding, so two SS58 strings for one key are equal even when their network prefixes differ.
  Anything that relied on the old string compare to tell networks apart needs the prefix from
  `ss58Decode` instead. The doc comment above the function said the opposite until now, which is
  fixed too.

  The correctness comes at a cost: a non-matching pair is decoded, roughly 20 microseconds, where an
  exact match still short-circuits for nothing. That is fine per call and adds up in a loop, so
  `publicKeysEqual` is now exported for that case. Decode the address you are searching for once
  with `ss58Decode`, then compare keys against each candidate.

  `confirmClaim` mapped every non-claiming draw to one of two phases, so a draw still assigning
  winners was reported as though the lifecycle had swept the winner row, which reads as "the window
  is over". It now reports the draw's real phase, and an unrecognised status variant fails on the
  error channel instead of being reported as some existing phase, matching every other decode here.

  **`claim_airdrop` has six gates, not five.** The prize asset must still be enabled for airdrops,
  and the check was missing. That matters because `Pays::No` applies only on success, so a claim
  this library green-lit and the chain refused cost the caller a fee. `readClaimEligibility` now
  reads `Airdrop.SupportedAssets` and reports a `PrizeAssetDisabled` blocker.

  **Breaking, before anything shipped:** `ClaimBlocker`'s `AttendedALaterGame` is now
  `DidNotAttendThisGame`. The chain tests `last_attended_game == game_index`, so the blocker also
  fires for a player who attended an earlier game or none at all, and the old name made a product
  render "you played again" to someone who never played. Compare `lastAttendedGame` to the game
  index to tell the three cases apart. `ClaimInputs` also gains a required `prizeAssetEnabled`.

  `claimPrizeTx` returned `unknown`, so the usage in its own documentation did not typecheck when
  passed to `submitAndWatch`. `ClaimChain` is now generic in the transaction type and the type is
  inferred from the chain, so the documented call compiles with no type argument and no cast.

  `readPrizeStatus`'s `NoGame` result now carries `lastGameIndex`, the game that just ended. That is
  the index a late claim is keyed by, and it was being discarded even though the underlying read
  returned it, forcing a second call on a second block.

  `ClaimEligibility.window` now documents what it does: the draw's deadlines whenever the draw
  exists, independent of whether this caller can claim. Read `claimable` for that.

  `readClaimEligibility` no longer reports `PrizeAssetDisabled` for a draw whose event row is gone.
  There is no asset id to look up there, so the gate is not applicable rather than failed, and
  `DrawNotClaiming` already explains the situation. `ClaimInputs.prizeAssetEnabled` is
  `boolean | null` for that reason.

  The registration scan builds its comparison once instead of per entry, which halved the time on a
  10,000-entry draw in a local measurement. It also makes a malformed account address fail the same
  way every time, where before it threw only if the draw happened to contain an account entry and
  answered "not registered" otherwise.

  The `product-sdk-individuality` skill now documents the game, the draws and the claim, including
  the six gates, the fee on a refused claim, and why the claim deadline is not a timestamp.

## 0.1.1

### Patch Changes

- 646d591: **Build + docs cleanup affecting published artifacts.**

  No public API changes. Two improvements that change shipped bytes:

  - `tsup` `treeshake: true` is now enabled across every package's build config (#48), so dead in-source vitest test code is stripped from the published bundles. Smaller install footprint with no behavior change.
  - `@packageDocumentation` blocks and TSDoc comments added across the SDK (#38), surfaced in the published `.d.ts` files for editor hover docs and the docs site.

  Packages already taking a `minor` bump in this release (`bulletin`, `chain-client`, `contracts`, `descriptors`, `host`, `keys`, `signer`, `statement-store`, `tx`, `sdk`) inherit these changes via that bump and are not listed here.

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.
