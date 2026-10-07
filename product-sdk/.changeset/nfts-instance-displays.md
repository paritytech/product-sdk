---
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

`getInstanceDisplays(chain, instances)` reads the display metadata of minted
NFTs by instance id: `name`, `collectionName`, `rarity`, `imageRef`, the full
three-layer `attributes` bag, the (collection, item) each instance was minted
from as the runtime resolves it, and `transferability`, `supply` and
`liveSupply` from its item definition.

`name` is the instance's own — its instance layer, else its item layer — and
does **not** inherit the collection's, which is reported beside it as
`collectionName`. Inheriting is right for `image` and `rarity`, where the
collection sets a default for its items, and wrong for `name`, where the
collection layer holds the name of a different thing. A deployment that names
its collection and titles items by `archetype` would otherwise see every item
wearing the collection's name. This differs from `CollectionItem.name`, which
merges the two; that read shipped first and this is the shape both should
have. Positional like `previewClaim`, with a per-instance `Found` /
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
widened from `number` to `number | bigint`. The constructor shape is unchanged
(`(id, options?)`): which space the id missed follows from the value's type.

`getCollectionItems` now refuses an item definition carrying a transferability
variant this package does not know with an `NftsDecodeError`, instead of
passing the unknown string through a field typed as the `Transferability`
union. It is the same refusal `getInstanceDisplays` makes, through the one
shared decoder. This is a behavior change for consumers: the two variants the
runtime has today still read as before, but a future third variant now fails
the read on the `err` channel where it previously reached callers as an
untyped string, so a consumer wanting to tolerate an unknown variant must
handle the `NftsDecodeError`.
