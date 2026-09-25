# NFT credits, preview and artwork reads: analysis and plan

## Summary

The three reads are buildable now, and the one the package header calls blocked is not.
`NftClaimsApi.preview_mints` is in the pinned Paseo Asset Hub descriptor. What stops
`previewClaim` today is the structural `NftsChain` contract, which exposes `query` and
never `apis`. That is a contract extension, not a descriptor regeneration.

Every storage entry and runtime API the three reads need exists in the generated
descriptors for both chains. `getCredits` is the only read that needs a second chain, the
People chain, which `product-sdk-chain-client` names `individuality`.

Recommendation: three phases in the order jollity needs them, credits, then preview, then
artwork, each its own changeset. Grow the contract by composition, a `NftsCreditsChain`
beside `NftsChain`, so the catalogue reads stay Asset Hub only and their fidelity guard
stays valid.

## Current state

### What PR 329 ships

Three catalogue reads over six storage entries, all Asset Hub, structurally typed in
`product-sdk/packages/nfts/src/chain.ts:83-213` as `NftsChain`, which carries
`assetHub.query` and `raw.assetHub.getFinalizedBlock` and nothing else. The header at
`product-sdk/packages/nfts/src/index.ts:90-93` lists runtime APIs as deliberately unused and
says `previewClaim` waits on `preview_mints` being reachable. The compile-time fidelity
guard in `product-sdk/packages/sdk/src/nfts/contract.test.ts` asserts a real Paseo client
satisfies `NftsChain` and a devnet client does not.

### What the descriptors carry

Checked in the generated Paseo descriptors, which are gitignored and built by
`pnpm generate`:

| Needed by | Entry | Chain | Present |
|---|---|---|---|
| `getCredits` | `NftCredits.NftClaimCreditBlocks` | individuality | yes |
| `getCredits` | `NftCredits.NftClaimCreditAwards` | individuality | yes |
| `getCredits` | `NftCreditsApi.nft_claim_credit_roots` | individuality | yes |
| `getCredits` | `NftCreditsApi.nft_claim_credit_proofs` | individuality | yes |
| `getCredits` | `NftClaims.CreditTrees` | assetHub | yes |
| `getCredits` | `NftClaims.ClaimedCredits` | assetHub | yes |
| `previewClaim` | `NftClaimsApi.preview_mints` | assetHub | yes |
| `previewClaim` | `Scarcity.ItemMetadata`, `CollectionMetadata` | assetHub | yes, already used |
| `getVerifiedArtwork` | none, it is a fetch and a hash | | |

`product-sdk/packages/descriptors/chains/paseo-asset-hub/.papi/polkadot-api.json` and the
individuality sibling pin the metadata each is generated from.

### What the stash does by hand

- `scarcity-stash/src/chain/pallets/credits.ts:170` `fetchCredits`: reads
  `NftClaimCreditBlocks` and `nft_claim_credit_roots` together, then for each rooted block
  `nft_claim_credit_proofs` (`:87`), and for each rootless block the awards buffer
  (`:158`). Returns `Credit { hash, awardedAt?, awardBlock?, root?, leaf? }` (`:44`).
- `scarcity-stash/src/chain/pallets/claims.ts:36` `fetchClaimStates`: `CreditTrees`
  by block (`:51`), then `ClaimedCredits.getEntries(block)` per rooted block (`:61`), and
  derives `earned | claimable | claimed` (`:28`).
- `scarcity-stash/src/chain/pallets/preview.ts:34` `previewMints`: one
  `preview_mints` call for a batch of (credit, collection) pairs (`:44`), then one
  `metadata_batch` for the mints outcomes. Returns `MintPreview { collection, outcome }`
  where outcome is `mints { item, via, name?, imageUrl? }` or `fails { reason }` (`:23`).
- `scarcity-stash/src/collectibles/verifiedArt.ts:28` `fetchAndVerify`: fetch by
  gateway URL, verify the bytes against the CID multihash (`:33`), cache by CID (`:48`).

### What jollity-next invents

`jollity-next/lib/game-source.ts:623-654` reads credits over its own papi and calls
`resolveCollectable(credit.hash)` at `:641`, a local hash to catalogue guess that
`scarcity-stash/docs/READ_PATH.md:118-133` records as verified wrong: a claim mints with
empty metadata, so no item carries its credit hash. Its artwork loader,
`jollity-next/lib/collectable-art.ts:52-75`, fetches but never verifies.

## Options considered

### How the contract grows a second chain

1. **Add `individuality` to `NftsChain` and require both.** One contract, but every
   catalogue read then demands a People connection it never uses, and the fidelity guard
   for the devnet negative control changes meaning.
2. **A separate `NftsCreditsChain`, composed for `getCredits`.** Catalogue reads keep
   `NftsChain` unchanged. `getCredits` takes `NftsChain & NftsCreditsChain`, matching how
   `readCurrentGame` takes `GameChain & GamePlayersChain` in
   `product-sdk/packages/individuality/src/game-read.ts:121-124`. The chain-client preset
   satisfies both at once, since it carries `assetHub` and `individuality` together.
3. **A chain parameter per read.** Two clients threaded by the caller. Nothing else in the
   SDK does this.

Recommendation: option 2. It is additive, it is the sibling package convention, and it
keeps `contract.test.ts` true for what it already asserts. Name the chain `individuality`,
not `people`, because that is what `getChainAPI` returns.

### Where `preview_mints` goes

Extend `NftsChain` with `assetHub.apis.NftClaimsApi.preview_mints`. The descriptor
already types it, so the fidelity guard catches drift. This corrects the header claim in
`index.ts:90-93`, which should be rewritten rather than left as history.

### Where artwork verification lives

`cloud-storage/src/verify.ts:92` `verifyStored` proves a CID was stored on Bulletin by
reading `TransactionStorage`. That is a different question from "are these bytes the
content this CID names", which needs no chain. `cloud-storage/src/cid.ts` already has
`hashToCid` and `cidToPreimageKey`. Recommendation: `getVerifiedArtwork` lives in `nfts`,
takes an `ImageRef` plus a fetch strategy, and reuses the cid helpers from cloud-storage
rather than copying the multihash code. Both forms of `ImageRef` resolve: `text` is a CID,
`hex` is a digest that `hashToCid` turns into one.

## Risks and unknowns

| Unknown | Why it matters | Cheapest resolution |
|---|---|---|
| Which `AccountOrPerson` key credits are awarded under | 318 says account-era and person-era credits sit under separate keys with no link, so `getCredits(identity)` may need both | Ask the pallet team on 318, and until answered accept both keys as `identity` and read both, the way `ownerKey` in the stash builds either |
| `nft_claim_credit_proofs` failing with `AwardsPruned` | The stash logs and drops those credits (`credits.ts:87-96`), so a display read silently loses old credits | Return them with `state: "unprovable"` rather than dropping, and say so in the type |
| `preview_mints` for a `Contract` selection | It runs the real selector, which for a contract collection may cost a dry run | Time one call against Paseo in the demo before promising a per-page cost |
| Purses | 318 says most of its surface waits on purses. None of these three needs one, but `getOwnedNfts` does | Out of scope here, note it in the changeset so nobody expects it |
| Gateway origin for artwork | The stash hardcodes a gateway URL, the SDK cannot | Take the fetch as a parameter, default to the host preimage manager inside a container |
| Descriptor whitelist drift | Apps pruning descriptors must add every new entry | List all new entries in the `index.ts` whitelist section, the same way the six are listed today |

Breakage to watch: `NftsChain` is exported, so adding `apis` is additive but changes what a
hand-rolled test double must provide. Every existing fake in the nfts tests needs the
field, or the reads that use it need to tolerate its absence at runtime with a
`NftsChainEntryError`.

## Phased plan

### Phase 1: getCredits

Goal: one read that answers "which credits does this identity hold, and in what state".

1. Add `NftsCreditsChain` to `chain.ts`: `individuality.query.NftCredits` for the two
   storage entries, `individuality.apis.NftCreditsApi` for roots and proofs,
   `assetHub.query.NftClaims` for `CreditTrees` and `ClaimedCredits`, and
   `raw.individuality.getFinalizedBlock`.
2. Add a `Credit` type to `types.ts` with `hash`, `awardBlock`, `awardedAt`, `root`,
   `leaf` and `state: "earned" | "claimable" | "claimed" | "unprovable"`.
3. Port `fetchCredits` and `fetchClaimStates` into `credits.ts`, pinning one block per
   chain and reporting both in `at`. Two chains cannot share a block hash, so the result
   carries `at: { individuality, assetHub }`.
4. Extend `sdk/src/nfts/contract.test.ts` with the new contract against the Paseo client.
5. Tests in `credits.ts` under `import.meta.vitest`, with a fake for each chain, covering
   rooted, rootless and pruned blocks and all four states.
6. Demo: a fourth step in `examples/nfts-demo/src/main.ts` and a spec that reads credits
   for the demo account.
7. Changeset in `pending-changesets/`: `@parity/product-sdk-nfts` minor and
   `@parity/product-sdk` minor.

Exit: `pnpm --filter @parity/product-sdk-nfts test`, `typecheck` and `build` pass,
`pnpm check` is clean, and the demo prints a credit list against Paseo.

### Phase 2: previewClaim

Goal: for one credit and a list of collections, the item each would mint, with its name,
rarity and image reference.

1. Add `assetHub.apis.NftClaimsApi.preview_mints` to `NftsChain`, and rewrite the
   `index.ts:90-93` note to say why runtime APIs are now in scope.
2. Add `MintPreview` to `types.ts`, mirroring the stash shape but with `imageRef` instead
   of `imageUrl`, so it matches `CollectionItem`.
3. Port `previewMints` into `preview.ts`. Resolve the mints outcomes through the existing
   exact-key `readTypedKeys` path in `items.ts`, not a new `metadata_batch` call, so name,
   rarity and image come from the same code path the catalogue uses.
4. Tests, demo step, contract test line, changeset.

Exit: as phase 1, plus the demo shows a preview for a real credit against a claimable
collection.

### Phase 3: getVerifiedArtwork

Goal: bytes for an `ImageRef`, verified against the digest, or `null`.

1. Add `cloud-storage` as a dependency of `nfts` for `hashToCid` and `cidToPreimageKey`,
   or lift those two helpers into `utils` if the dependency direction is wrong.
2. `artwork.ts`: accept `ImageRef`, derive the CID from `text` or `hex`, fetch through a
   caller-supplied `fetch(cid)` with a default that uses the host preimage manager, hash
   the bytes, compare, return `Blob | null`.
3. Tests with fixed bytes and a wrong-digest case. No network in unit tests.
4. Changeset.

Exit: as phase 1, plus one demo image rendered from verified bytes.

## Checklist

- [ ] `NftsCreditsChain` contract, `packages/nfts/src/chain.ts`, done when the Paseo client type satisfies it in `contract.test.ts`
- [ ] `Credit` type with four states, `packages/nfts/src/types.ts`, done when exported from `index.ts`
- [ ] `getCredits`, `packages/nfts/src/credits.ts`, done when rooted, rootless, pruned and claimed cases each have a passing test
- [ ] Credits demo step and spec, `examples/nfts-demo`, done when the e2e prints credits for the demo account
- [ ] Phase 1 changeset, `pending-changesets/nfts-credits.md`, done when it lists nfts and the umbrella at minor
- [ ] `preview_mints` on `NftsChain`, `packages/nfts/src/chain.ts`, done when the fidelity guard compiles against Paseo
- [ ] Rewrite the runtime API note, `packages/nfts/src/index.ts`, done when it no longer says preview waits on reachability
- [ ] `previewClaim`, `packages/nfts/src/preview.ts`, done when a mints and a fails outcome each have a passing test
- [ ] Preview demo step, `examples/nfts-demo`, done when the e2e shows an item for a real credit
- [ ] Phase 2 changeset, `pending-changesets/nfts-preview.md`, done when it lists nfts and the umbrella at minor
- [ ] Decide where cid helpers live, `packages/nfts/package.json` or `packages/utils`, done when the dependency builds without a cycle
- [ ] `getVerifiedArtwork`, `packages/nfts/src/artwork.ts`, done when a matching and a mismatching digest each have a passing test
- [ ] Phase 3 changeset, `pending-changesets/nfts-artwork.md`, done when it lists nfts and the umbrella at minor
- [ ] Ask on issue 318 which `AccountOrPerson` key awards use, done when the answer is recorded in the `Credit` doc comment
