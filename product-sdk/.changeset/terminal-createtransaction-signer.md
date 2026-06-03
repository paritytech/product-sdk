---
"@parity/product-sdk-terminal": minor
---

**Route transaction signing through `createTransaction`, derive the product-account key, and remove the obsolete `verifiablejs` WASM loader.**

Transaction signing (`PolkadotSigner.signTx`) now goes through `session.createTransaction` (the host-papp `CreateTransactionRequest`/`CreateTransactionResponse` SSO pair) instead of `session.signRaw({ tag: "Payload" })`. The paired wallet now builds **and** signs the extrinsic from the structured `ProductAccountTransaction`, so:

- the wallet can **decode and display** the transaction instead of blind-signing opaque bytes, and
- every signed extension the chain declares — including ones PAPI's PJS adapter doesn't know (e.g. `AsPgas` on Paseo Next v2) — is forwarded verbatim and survives end-to-end.

`signBytes` is unchanged (still `session.signRaw({ tag: "Bytes" })` for the anti-phishing envelope).

**Product-account public key.** `createSessionSigner(session, adapter, publicKey?)` and `ProductAccountRef.publicKey` now accept the host-derived **product-account** sr25519 key. PAPI stamps this into the extrinsic's signer address and verifies against it, so it must be the product account's key (`[productId, derivationIndex]`), not the wallet's selected/root account. When omitted, it falls back to the selected account (correct only when they're the same).

**Bumps `@novasamatech/host-papp`, `@novasamatech/statement-store`, and `@novasamatech/storage-adapter` `^0.7.7` → `^0.8.1`** (resolves `0.8.3`). 0.8 is wire-incompatible with 0.7 and adds `UserSession.createTransaction`.

### Breaking changes

- **Removed the `@parity/product-sdk-terminal/register` entrypoint** (and its `postinstall` WASM patch). It existed only to redirect `verifiablejs`'s browser-only inline WASM to a Node build; host-papp 0.8 no longer depends on `verifiablejs` (its sr25519 primitives are pure JS), so the loader is obsolete. **Migration:** drop any `--import @parity/product-sdk-terminal/register` flag from your `node`/`tsx` invocations — nothing replaces it.
- **Dropped the `AttestationStatus` type re-export**, which was removed upstream from `@novasamatech/host-papp` in the same release line.
- **Removed `TerminalAdapterOptions.metadataUrl`** — host-papp 0.8 no longer embeds app metadata in the pairing proposal, so the field had no effect. **Migration:** drop it from `createTerminalAdapter(...)` calls.
