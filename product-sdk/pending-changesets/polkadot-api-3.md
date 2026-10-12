---
"@parity/product-sdk": minor
"@parity/product-sdk-address": minor
"@parity/product-sdk-auth": minor
"@parity/product-sdk-chain-client": minor
"@parity/product-sdk-cloud-storage": minor
"@parity/product-sdk-contracts": minor
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-individuality": minor
"@parity/product-sdk-keys": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk-statement-store": minor
"@parity/product-sdk-terminal": minor
"@parity/product-sdk-tx": minor
---

**Moves the SDK to polkadot-api 3.** Breaking for every caller that signs.

PAPI 3 replaced the `PolkadotSigner` with a `TxCreator`, which receives one payload holding the call, every transaction extension, the pipeline version those extensions belong to, and the runtime metadata. Every signer the SDK builds or accepts is now a `CommonSignerTxCreator` from `@polkadot-api/signers-common`: `getProductAccountSigner` and `getLegacyAccountSigner` in host, `SignerManager.getSigner`, `seedToAccount` and the key manager in keys, `createDevSigner` in tx, the session, slot-account and allowance signers in terminal, and the signers `resolveSigner` returns in auth. `submitAndWatch`, `batchSubmitAndWatch` and contract calls take it unchanged. A PAPI transaction is now submitted with `createSubmitAndWatch` or `createAndSubmit`, fees are estimated with a creator such as `getFakeTxCreator(address)`, and the transaction events `signed` and `txBestBlocksState` are now `created`, `inBestBlock` and `notInBestBlock`. The `TxEvent` type in tx follows.

`withAsPerson`, `withLiteAlias` and `withScoreParticipant` now wrap a `TxCreator`. They fill the standard extensions with the PAPI 3 enhancers, write their origin extension, and hand the inner signer the pipeline version that carries it, so the host is told the version the proof was built for instead of inferring one. This replaces the slot filling that worked around PAPI 2 only knowing pipeline version 0. A fee estimate through a wrapper is priced as a plain account transaction and never requests a proof.

Host exports `createHostTxCreator`, also published as the transport-free subpath `@parity/product-sdk-host/tx-creator`, which terminal uses for the paired-phone signer. The `txExtVersion` signer option is now the version used when the transaction names none.

Terminal moves to `@novasamatech/host-papp`, `statement-store` and `storage-adapter` 0.12.0, and host to `@novasamatech/host-api-wrapper` 0.12.0, the releases built for PAPI 3. The descriptors are regenerated with the PAPI 3 CLI.

Cloud Storage uploads need a `@parity/bulletin-sdk` release built for PAPI 3. Version 0.3.0 still submits with `signSubmitAndWatch`, which a PAPI 3 transaction does not have.
