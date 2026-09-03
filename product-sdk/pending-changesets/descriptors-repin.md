---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk": minor
---

**Re-pin every drifting chain (#242), including five that were re-genesised.**

The bundled descriptors addressed chains that no longer exist. Access is gated on the genesis
hash, so a stale genesis fails at connection with `GenesisMismatchError` before any storage read.
A stale `codeHash` only means decoding against an old metadata snapshot; a stale genesis means
addressing a chain that is not there.

| Chain | Old genesis | New genesis |
| --- | --- | --- |
| `paseo-individuality` | `0x89a63b11…5440f` | `0x4a2b5b73…5ad48` |
| `previewnet-individuality` | `0x34999c29…5d220` | `0xf720c28f…35218` |
| `paseo-asset-hub` | `0x23e730eb…a2ca6` | `0x4349b00e…` |
| `previewnet-asset-hub` | `0x627f5441…29659` | `0xc27c8bf3…` |
| `previewnet-bulletin` | `0x1144acd2…04e89` | `0xea9158d7…` |

`devnet-asset-hub`, `devnet-individuality`, `kusama-asset-hub`, `paseo-bulletin` and
`polkadot-asset-hub` kept their genesis and took a fresh `codeHash` only. All eleven chains now
match their live runtimes.

**Minor rather than patch, because surface is removed**, which on 0.x signals a breaking change.
Check this before upgrading; a green `pnpm typecheck` here does not clear consumers.

| Chain | Removed | Added |
| --- | --- | --- |
| `paseo-individuality` | pallet `StorageInitialization`, `Score.Suffix` constant | pallets `NetworkSuffix`, `Parameters`, `AssetConversion`, `PoolAssets`, `PeopleAirdrops` |
| `previewnet-individuality` | `Score.Suffix` constant | pallet `NetworkSuffix` |
| `paseo-asset-hub` | `AsRingAlias` transaction extension | pallet `NetworkSuffix` |
| `previewnet-asset-hub` | none | pallet `NetworkSuffix` |
| `polkadot-asset-hub` | none | pallet `Psm` |

Two consequences worth reading if you use the individuality surface.

**The network suffix moved from a constant to storage on both individuality chains.** Neither
publishes `Score.Suffix` any more, so `readScoreContext` and `readLiteSignUpRequirement` now take
the `NetworkSuffixChain` overload and read it at a pinned block. A caller-supplied `tld` still wins
where you pass one. Previewnet's own suffix changed with it, from `test` to `testnet`, so its
`Score.score_context` moved from `0xa02ef8d9…` to `0x643d4ff6…`. Paseo's is unchanged at
`0x99f1920e…`. If you derived a context from a hardcoded `test`, it no longer matches previewnet.

**`paseo-individuality` gained `PeopleAirdrops`.** The airdrop read surface now has a chain that
carries the pallet, where before only previewnet did.

`@parity/product-sdk-cloud-storage` takes a minor because it now addresses a different chain:
`CloudStorageNetworks.previewnet.genesisHash` restated the hash by hand and was pointing at a
previewnet Bulletin that no longer exists. Read it from the descriptor rather than copying it, since
these chains are re-genesised periodically.

`@parity/product-sdk-chain-client` needs no entry. It reads `.genesis` off the imported descriptor,
so only its in-source tests restated the hashes, and its published output is unchanged.
`CloudStorageNetworks.previewnet.genesisHash` was pointing at a previewnet Bulletin that no longer
exists. If you pinned a hash yourself, read it from the descriptor instead: these chains are
re-genesised periodically, so any copy goes stale on its own schedule.
