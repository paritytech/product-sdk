---
"@parity/product-sdk": patch
"@parity/product-sdk-chain-client": patch
"@parity/product-sdk-cloud-storage": patch
"@parity/product-sdk-contracts": patch
"@parity/product-sdk-descriptors": patch
"@parity/product-sdk-host": patch
"@parity/product-sdk-keys": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk-statement-store": patch
"@parity/product-sdk-terminal": patch
"@parity/product-sdk-tx": patch
---

chore(deps): bump polkadot-api to 2.1.6

Updates the `polkadot-api` catalog entry `^2.1.5` → `^2.1.6` (2.1.6 carries the
double-notification fix). Every published package resolves `polkadot-api`
through `catalog:`, so each one's published `dependencies` range moves to
`^2.1.6`. There is no source change in any package — these are patch bumps to
ship the new floor via the published `catalog:` resolution.

Releases the catalog bump from #223, which was merged to `main` without a
changeset.
