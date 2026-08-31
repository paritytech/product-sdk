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

`readScoreContext(chain)` reads `Score.score_context` and `Score.Suffix` and
checks the constant equals `productContext("peopl." ++ suffix, Index(0))`. A
runtime still publishing a literal context (which no stock host can mint) answers
`NotProductDerived` on the ok channel, so proof-building flows stop before the
chain rejects the transaction with nothing local to read.

First piece of the lite-personhood sign-up flow (product-sdk#286): consolidates
the derivations dim2 and humanity each hand-roll today, pinned by the same
vectors (previewnet's published constants, both collection ids).
