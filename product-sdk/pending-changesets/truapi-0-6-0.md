---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

Update `@parity/truapi` to 0.6.0. Product-account derivation indexes are now
tagged `DerivationIndex` selectors on the wire (`{ tag: "Left", value: number }`
for a plain index, `{ tag: "Right", value: <32-byte hex> }` for a raw index).
The ergonomic account surfaces keep plain numbers — `getProductAccount(id,
index)` and `ProductAccount.derivationIndex` are unchanged, with the host
adapter wrapping them as `Left` — but the pass-through shapes track the
protocol: `ProductProofContext.suffix` (ring VRF contexts, exported from both
host and signer) is now the tagged selector instead of a hex string, and
`PaymentTopUpSource`'s `ProductAccount` source and `AllocatableResource`'s
`SmartContractAllowance` value carry it too. The
`DerivationIndex` type is exported from host and signer. The release also
brings the host's new sr25519 `account.signVrf` API (not yet wrapped by an SDK
accessor).
