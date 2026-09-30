---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

Let a read address its block the way PAPI's `at` does. `readSignUpFunds`,
`readGameSignUpRequirement`, `readLiteSignUpRequirement` and `readAirdropDraw`
take `at: "finalized" | "best" | BlockSnapshot`, and `getClaims` takes the same
as `individualityAt` for its People read. `"finalized"` stays the default.

The raw client these reads take is now `BlockSource`, the part of PAPI's
`PolkadotClient` they use, so it names `getBestBlocks` next to
`getFinalizedBlock`. Every `PolkadotClient` has both, so `fromPapi` and
`getChainAPI` callers change nothing. A hand-built raw client needs
`getBestBlocks` added. `FinalizedBlockSource` stays as a deprecated alias.
`BlockSnapshot` names the pinned block, and `FinalizedSnapshot` stays as an
alias of it.
