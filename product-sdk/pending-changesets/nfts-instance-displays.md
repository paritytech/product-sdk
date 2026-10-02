---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

`getInstanceDisplays(chain, instances)` reads the display metadata of minted
NFTs by instance id: `name`, `rarity`, `imageRef`, the full three-layer
`attributes` bag, the (collection, item) each instance was minted from as the
runtime resolves it, and `transferability`, `supply` and `liveSupply` from its
item definition. Positional like `previewClaim`, with a per-instance `Found` /
`NotFound` tag — an unminted or burned instance is a clean miss on the `ok`
channel, and an instance with no metadata at all (every claim-minted one
today) is still `Found`. `getInstanceDisplay` is the same read for one id.

The read takes its own chain contract, `NftsInstancesChain`: the runtime API
`api.ScarcityApi.metadata_batch` and `query.Scarcity.ItemDefs`, both of which
a pruned descriptor whitelist must carry, plus the raw client. A `getChainAPI`
client satisfies it whole. Batches are chunked at `METADATA_BATCH_LIMIT` (128,
the live runtime's cap) and re-chunk once to a smaller cap a deployment
reports; the definitions are then one keyed read over the deduplicated
`(collection, item)` pairs, so they cost one serial hop and nothing per
instance. The three definition-backed fields are `null` together, and only
when the definition is gone from under a live instance.

`NftsIdError` now also reports out-of-range `u64` instance ids; its `id` field
widened from `number` to `number | bigint`.
