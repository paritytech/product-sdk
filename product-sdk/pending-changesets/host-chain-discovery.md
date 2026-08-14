---
"@parity/product-sdk-host": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk": minor
---

Consume TrUAPI host chain discovery. `@parity/product-sdk-host`
gains `getHostChainInfo()`, a cached facade over `chain.getChainInfo()` that
resolves chain roles (`AssetHub`, `Bulletin`, `People`, …) to genesis hashes
and returns `null` on hosts predating discovery. `getChainAPI()` can now be
called with no argument to derive the environment from the host by matching
the discovered asset hub genesis against the bundled descriptors; an explicit
environment is validated the same way, failing with the new `EnvironmentMismatchError` /
`GenesisMismatchError` instead of an opaque unsupported-genesis error. Legacy
hosts keep exactly the previous behavior. `@parity/truapi` is bumped to
`^0.9.0`, the release that ships the `chain.getChainInfo` binding.
