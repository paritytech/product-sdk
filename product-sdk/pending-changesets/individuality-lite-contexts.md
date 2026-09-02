---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Product-scoped proof contexts and personhood ring locations, as pure helpers.**

Every context a host will sign under, and every context a product-derived runtime
accepts, is `blake2b-256("product/" ++ productId ++ "/" ++ suffix)` with the
RFC-0024 `Index`/`Raw` suffix expansion. `productContext(productId, suffix)`
computes it offline, `contextSuffixBytes` exposes the expansion, and
`personhoodContext(tld, name)` enumerates the five contexts the personhood
product owns (`PERSONHOOD_CONTEXT_INDEX`) — needed because two of them never
reach metadata. Product ids are always full DotNS ids (`"peopl.test"`,
`"dim2.dot"`): the TLD belongs to the network and is never defaulted.

`peopleRing(genesis)` and `litePeopleRing(genesis)` build the two personhood
`RingLocation`s (the space-padded `CollectionId`s from `ringCollectionId`),
structurally compatible with `@parity/product-sdk-host` without depending on it.

`readScoreContext(chain)` reads `Score.score_context` and checks it equals
`personhoodContext(<network suffix>, "score")`. A runtime publishing a literal
context (which no stock host can mint) answers `NotProductDerived` on the ok
channel, so proof-building flows stop before the chain rejects the transaction
with nothing local to read.

Where the network suffix comes from is part of the chain's type, not a runtime
fallback: `NetworkSuffixChain` for the Root-settable `NetworkSuffix.NetworkSuffix`
storage that individuality-community#20 introduced (read at a pinned block, since
Root can move it), `LegacySuffixChain` for the `Score.Suffix` constant it
replaced, and a `tld` option for a runtime with neither — which is every
production runtime, since that pallet is testnet-only. A chain that can offer no
suffix and no `tld` is a compile error rather than a runtime disappointment.
`runScoreContextRead` is the throwing variant, so a composing read can run it
against a block it already pinned instead of pinning a second one.

First piece of the lite-personhood sign-up flow (product-sdk#286): consolidates
the derivations dim2 and humanity each hand-roll today, pinned by the same
vectors (previewnet's published constants, both collection ids).
