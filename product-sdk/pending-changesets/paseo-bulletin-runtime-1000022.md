---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk": minor
---

**Regenerate `paseo-bulletin` descriptors for the upcoming `v0.0.22-paseo` runtime (spec `1_000_022`).**

Metadata was extracted offline from the `polkadot-bulletin-chain` `v0.0.22-paseo` release wasm (`papi add --wasm`) ahead of its deployment to Paseo Next v2, which currently runs spec `1_000_021`. Merge/publish this once the runtime upgrade is enacted on-chain.

Runtime changes surfaced in the descriptors:

- New `DataRenewal` pallet (`pallet_bulletin_data_renewal`, pallet index 42) — new tx/query/event API surface, hence the minor bump.

The pinned `codeHash` is pre-set to the release blob's blake2-256 (`0xabb9c076…`, matching what on-chain `:code` will hash to after the upgrade); `genesis` is unchanged.
