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
client satisfies it whole.

The read is capped at `MAX_INSTANCES_PER_READ` (128) instances per call and
refuses above it rather than paging: every other read here walks a space the
chain sizes, while this one answers a list the caller already holds, so a
cursor would page someone over their own input. The cap is the package's
contract rather than a reading of the chain, though it coincides with the live
runtime's `metadata_batch` cap, so a full read is one runtime call there and a
deployment configured lower reports its own cap for the read to re-chunk to.
The definitions are then one keyed read over the deduplicated
`(collection, item)` pairs, so they cost one serial hop and nothing per
instance. The three definition-backed fields are `null` together, and only
when the definition is gone from under a live instance.

`NftsIdError` now also reports out-of-range `u64` instance ids; its `id` field
widened from `number` to `number | bigint`.
