---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk": minor
---

**Regenerate `devnet-bulletin` descriptors for the upcoming `bulletin-paseo` runtime from `paseo-network/runtimes` `v2.5.0` (spec `2_004_000`, wiring `polkadot-bulletin-chain` `v0.0.26-paseo`).**

Metadata was extracted offline from the `v2.5.0` release wasm (`papi add --wasm`) ahead of its deployment to the Products Devnet Bulletin (Paseo para 1010), which still runs the runtime pinned when the devnet environment was added (#246). Merge/publish this once the runtime upgrade is enacted on-chain.

Runtime changes surfaced in the descriptors (the devnet pin predates the `v0.0.22` data-renewal split, so this jump includes everything `paseo-bulletin` got in #280 plus the `v0.0.23`–`v0.0.26` additions):

- New `DataRenewal` pallet (`pallet_bulletin_data_renewal`) — new tx/query/event API surface, hence the minor bump. `renew`, `force_renew`, `enable_auto_renew` and `disable_auto_renew` **move off `TransactionStorage`** onto the new pallet, joined by a new `process_pending_renewals` mandatory inherent; `PermanentStorageUsed` / `MaxPermanentStorageSize` move with them. Renames on the way: `DataAutoRenewed` → `DataRenewed`, `AutoRenewalFailed` → `RenewalFailed`, `AutoRenewalAlreadyEnabled` → `RenewalAlreadyEnabled`; the `PermanentAllowanceExceeded` / `ChainPermanentCapReached` errors are dropped.
- `@parity/product-sdk-cloud-storage` bumps `@parity/bulletin-sdk` to `^0.4.0`, which resolves the renewal-pallet split at runtime — `CloudStorageClient.renew()` now works on both pre-split (`TransactionStorage.renew`) and post-split (`DataRenewal`) runtimes.
- New `HopPromotion.promote_v2` call — the signing payload additionally covers the chain genesis hash and a hash of the recipients list.
- Transaction-pool constants reworked: per-call `*TxParams` records replace `StoreRenewPriority` / `StoreRenewLongevity` / `RemoveExpiredAuthorization{Priority,Longevity}`.
- New `RelayParentOffsetApi.max_claim_queue_offset` runtime API.

The pinned `codeHash` is pre-set to the release blob's blake2-256 (`0x744ee1c1…`, matching what on-chain `:code` will hash to after the upgrade); `genesis` is unchanged.
