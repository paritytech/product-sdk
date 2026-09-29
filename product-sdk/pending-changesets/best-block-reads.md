---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk-nfts": minor
"@parity/product-sdk": minor
---

Let a read follow a best-block watch without lagging finality. `readSignUpFunds`,
`readGameSignUpRequirement`, `readLiteSignUpRequirement` and `readAirdropDraw`
take `at: "best"` or a snapshot, and `getClaims` takes `individualityAt` for its
People read. `"best"` needs a client with `getBestBlocks`, which PAPI's
`PolkadotClient` has. The finalized default is unchanged.
