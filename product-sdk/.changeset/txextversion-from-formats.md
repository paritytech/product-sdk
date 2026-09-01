---
"@parity/product-sdk-host": patch
"@parity/product-sdk-terminal": patch
---

**Derive `txExtVersion` from the extrinsic format list, so a V5-only runtime can be signed again.**

The signer factories fill the truapi `create_transaction` field `txExtVersion`. Since host `0.18.0` and terminal `0.8.0` the V5 value was gated on the runtime's transaction-extension version map (surfaced by PAPI as the keys of `metadata.extrinsic.signedExtensions`) containing `5`. No runtime declares extension version `5`, every deployed runtime declares only `0`, so that branch was unreachable and signing threw on any runtime offering extrinsic format 5 without format 4.

Both `@parity/product-sdk-host`'s `getAccountsProvider` signers and `@parity/product-sdk-terminal`'s session signers now read `metadata.extrinsic.version` alone: format 4 gives `0`, otherwise format 5 gives `5`, otherwise a throw naming the formats the runtime offers. That restores the behaviour published in host `0.17.0` and terminal `0.7.4`, and keeps the explicit rejection `0.18.0` added for a runtime offering neither format, where earlier versions sent the highest format number to a host that cannot use it. Both packages now also decode the tracked chain metadata under test, which is the check that would have caught this.

`0` and `5` are the values host-rust-core's `build_local_transaction` accepts, and that is the host iOS and dot.li run. What the field means is still open in product-sdk#339: the truapi protocol documents it as a transaction-extension version and the Android host reads it that way, so `5` is not universally correct. This release does not settle that.

No behaviour change on any chain the SDK ships against. They all offer extrinsic format 4, so `txExtVersion` was and remains `0`.
