---
"@parity/product-sdk-chain-client": patch
"@parity/product-sdk-cloud-storage": patch
"@parity/product-sdk-contracts": patch
"@parity/product-sdk-descriptors": patch
"@parity/product-sdk-host": patch
"@parity/product-sdk-keys": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk-statement-store": patch
"@parity/product-sdk-tx": patch
---

Bump shared catalog dependencies to their latest within range. Dependency-range updates only; no public API changes:

- `polkadot-api` `^2.1.2` → `^2.1.5` (all packages listed)
- `@polkadot-labs/hdkd-helpers` `^0.0.27` → `^0.0.30` (contracts, keys, tx)
- `viem` `^2.46.2` → `^2.52.0` (contracts)
- `@novasamatech/host-api` & `@novasamatech/host-api-wrapper` `^0.8.0` → `^0.8.3` (signer's optional deps; host/statement-store carry them as dev-only/unchanged peers)
