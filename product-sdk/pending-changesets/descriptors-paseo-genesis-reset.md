---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk": minor
---

**Re-pin `paseo-individuality` and `paseo-asset-hub` after a genesis reset (#242).**

Both chains were re-genesised, not upgraded, so the bundled descriptors addressed chains that
no longer exist. Access is gated on
`featureSupported({ tag: "Chain", value: { genesisHash } })`, so a stale genesis fails at
connection with `ChainNotSupportedError` before any storage read. A stale `codeHash` only
means decoding against an old metadata snapshot; a stale genesis means addressing a chain
that is not there.

| Chain | Old genesis | New genesis |
|---|---|---|
| `paseo-individuality` | `0xc5af1826…65afa5` | `0x89a63b11…48c5440f` |
| `paseo-asset-hub` | `0xbf0488db…ae4ef19f` | `0x23e730eb…f94a2ca6` |

**Breaking for `paseo-individuality`: the regeneration removes typed API surface.** A green
`pnpm typecheck` here does not clear consumers, so check this before upgrading.

| Pallet | Removed | Replacement |
|---|---|---|
| `Resources` | storage `FriendRequestRegistrationByAlias`, `FriendRequestAliasByAccount` | `NotificationRegistrationByAlias`, `NotificationAliasByAccount` |
| `Resources` | 6 `FriendRequest*` constants | 4 `Notification*` constants |
| `Game` | storage `Nfts`, `NftCandidates` | none |
| `Coinage` | storage `RecyclersUnloaded` | `RecyclerAliasStates`, `RecyclersArchives` |

`FriendRequestAllowance`, `FriendRequestSlotsPerPeriod`, `LiteFriendRequestSlotsPerPeriod` and
`FriendRequestPeriodDuration` map onto `Notification*` equivalents.
`FriendRequestGraceWindow` and `FriendRequestRetentionDuration` have no counterpart.

Added to `paseo-individuality`: pallets `RelayRandomness` and `NftCredits`, `Game` storage
`LiteInvites`, `Game` constant `max_received_votes`.

`paseo-asset-hub` is additive only: pallets `Scarcity` and `NftClaims`, plus `DotnsGateway`
constants `MaxValiditySeconds` and `MaxFutureSkewSeconds`. Safe to upgrade.

Minor rather than patch because surface is removed, which on 0.x signals a breaking change.
This is a firmer reason than the additive-only argument used for the 0.9.0 `paseo-bulletin`
bump. A re-pin that neither adds nor removes pallets stays a patch, as in 0.8.0.

If you pinned either hash yourself, read it from the descriptor (`loadDescriptors()`) instead.
Paseo Next is re-genesised periodically, so any copy goes stale on its own schedule.

The five other chains reported in #242 have unchanged genesis and need a separate routine
regeneration. #242 stays open until those land.
