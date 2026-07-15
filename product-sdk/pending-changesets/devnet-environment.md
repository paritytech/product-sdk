---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk": minor
---

**Add `devnet` — the public Paseo-testnet products devnet — as a new environment.**

Adds `devnet-asset-hub`, `devnet-bulletin`, and `devnet-individuality` (the
People chain) descriptors, generated against the community-run Paseo system
chains (Asset Hub 1000, People 1004, Bulletin 1010), and wires `devnet`
through the host Bulletin RPC list, the cloud-storage network preset, and
`getChainAPI("devnet")`. Unlike `paseo` — which targets the Paseo Next v2
deployment — `devnet` targets the long-lived public Paseo testnet. Purely
additive — no existing environment, descriptor, or endpoint changes.
