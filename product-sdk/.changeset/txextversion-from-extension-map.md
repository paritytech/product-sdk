---
"@parity/product-sdk-host": patch
"@parity/product-sdk-terminal": patch
---

**Derive `txExtVersion` from the transaction-extension version map, not the extrinsic format version.**

The signer factories fill the truapi `create_transaction` field `txExtVersion` with the **transaction-extension** version the host must decode extension values under. It was being derived from `metadata.extrinsic.version` — the extrinsic *format* versions (`4` / `5`) — which is a different concept (host-rust-core#528). For a V4 extrinsic the value is a fixed `0`; for a V5 general transaction it is a transaction-extension version from the runtime's v16 `transactionExtensionsByVersion` map (surfaced by PAPI as the keys of `metadata.extrinsic.signedExtensions`), which the host and runtime agree is `5` — a value that must exist in that map, not the highest extrinsic format number.

Both `@parity/product-sdk-host`'s `getAccountsProvider` signers and `@parity/product-sdk-terminal`'s session signers now read `extrinsic.signedExtensions`: V4 → `0`, else the general transaction-extension version `5` if the runtime lists it (throwing otherwise, rather than sending a format number the host can't decode under).

No behaviour change on the chains the SDK ships against today: they all offer extrinsic V4, so `txExtVersion` was and remains `0`. The bug was latent — it only produced a wrong value (the format number `5`) on a hypothetical V5-only runtime, which is exactly the case this corrects.
