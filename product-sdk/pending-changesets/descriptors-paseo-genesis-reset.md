---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk": minor
---

**Re-pin `paseo-individuality` and `paseo-asset-hub` after a genesis reset (#242).**

Both chains were **re-genesised**, not upgraded. The bundled descriptors addressed chains
that no longer exist:

| Chain | Old genesis | New genesis |
|---|---|---|
| `paseo-individuality` | `0xc5af1826…65afa5` | `0x89a63b11…48c5440f` |
| `paseo-asset-hub` | `0xbf0488db…ae4ef19f` | `0x23e730eb…f94a2ca6` |

A stale `codeHash` means decoding against an old metadata snapshot. A stale genesis means
addressing a different chain: access is gated on
`featureSupported({ tag: "Chain", value: { genesisHash } })`, so it fails at connection with
`ChainNotSupportedError` before any storage read.

**Minor rather than patch because the regeneration adds typed API surface**, matching the
0.9.0 bump for `paseo-bulletin`. The live runtimes carry pallets the pinned metadata did
not:

- `paseo-individuality`: `NftCredits`, `RelayRandomness`, plus expanded `Game` and `Airdrop`
- `paseo-asset-hub`: `Scarcity`, `NftClaims`

Existing calls are unaffected. `pnpm typecheck` and the workspace suite are clean, so
nothing consumers already use was removed or renamed. A routine re-pin with no new pallets
stays a patch, as in 0.8.0.

**What to do if you pinned either hash yourself.** Read it from the descriptor
(`loadDescriptors()`) rather than hard-coding it. Paseo Next is re-genesised periodically,
so any copy of the value goes stale on its own schedule.

The five other chains reported as drifting in #242 have unchanged genesis and are a
separate routine regeneration. #242 stays open until those land.
