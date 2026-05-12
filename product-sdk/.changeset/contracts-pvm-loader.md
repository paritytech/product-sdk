---
"@parity/product-sdk-contracts": minor
---

**Contracts: migrate to `pallet-revive` direct + viem ABI codec; drop `@polkadot-api/sdk-ink`.**

Drops `@polkadot-api/sdk-ink` for PolkaVM contracts built with `cargo pvm-contract`. Extrinsics + storage go through PAPI's typed API; the `ReviveApi.call` dry-run is routed through `client.getUnsafeApi()` to absorb descriptor-vs-chain compat-token drift.

### New surface

- `createContractRuntimeFromClient(client, descriptor)` — production factory; routes dry-run through the unsafe API.
- `createContractRuntime(typedApi)` — test factory using the typed API end-to-end.
- `ContractManager.fromClient(cdm, client, descriptor, options)` + `ContractManager.getRuntime()`.
- `ensureContractAccountMapped(runtime, address, signer, options?)` — idempotent app-boot helper for the SS58 ↔ H160 mapping `pallet-revive` requires.
- `ContractDryRunFailedError` — thrown by `.tx()` when the pre-flight dry-run fails, before signing.
- `/pvm` subpath: `parsePvmContractAbi`, `loadPvmContractAbi`, `loadPvmContractCode`, `loadPvmContractArtifacts`.
- `/codegen` subpath: `ContractTypeInput`, `resolveContractTypeInputs`, `generateContractTypes`.
- `.prepare()` on every contract method returns a `BatchableCall` consumable by `batchSubmitAndWatch` from `@parity/product-sdk-tx`.

### Breaking changes

- `@polkadot-api/sdk-ink` and its exports (`createInkSdk`, `InkSdk`, ink!-flavoured types) are removed. Consumers migrate via `createContractRuntime(typedApi)` or `ContractManager.fromClient(cdm, client, descriptor)`.
- `ReviveCallTx` / `ReviveTypedApi` use `HexString` for `dest` and `Uint8Array` for `data` (PAPI 2.x). Class-based `FixedSizeBinary<20>` / `Binary` are no longer accepted.
- Codegen output for Solidity `bytes` and `bytesN` aligns with PAPI 2.x: `bytes → HexString`, `bytesN → SizedHex<N>` (was `Binary` / `FixedSizeBinary<N>`). Re-run `cdm install` after upgrading to regenerate user-facing types.
- Node-only loaders + build-time codegen live on the `/pvm` and `/codegen` subpaths and are not re-exported from the main entry — keeps `fs`/`path`/`os` dynamic imports out of browser bundles that only need `ContractManager`.

### Bundle impact

Consumer ship-size drops from ~750 KB gzip (with `@polkadot-api/sdk-ink`) to ~73 KB gzip — about a 90% reduction for downstream consumers.
