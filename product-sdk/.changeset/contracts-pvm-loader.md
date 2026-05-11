---
"@parity/product-sdk-contracts": minor
---

**Contracts: migrate to `pallet-revive` direct + viem ABI codec.**

Drops `@polkadot-api/sdk-ink` for PolkaVM contracts built with `cargo pvm-contract`. Extrinsics + storage go through PAPI's typed API; the `ReviveApi.call` dry-run is routed through `client.getUnsafeApi()` to absorb descriptor-vs-chain compat-token drift.

### New surface

- `createContractRuntimeFromClient(client, descriptor)` — production factory; routes dry-run through the unsafe API.
- `createContractRuntime(typedApi)` — test factory using the typed API end-to-end.
- `ContractManager.fromClient(cdm, client, descriptor, options)` + `ContractManager.getRuntime()`.
- `ensureContractAccountMapped(runtime, address, signer, options?)` — idempotent app-boot helper for the SS58 ↔ H160 mapping `pallet-revive` requires.
- `ContractDryRunFailedError` — thrown by `.tx()` when the pre-flight dry-run fails, before signing.
- `/pvm` subpath: `parsePvmContractAbi`, `loadPvmContractAbi`, `loadPvmContractCode`, `loadPvmContractArtifacts`.
- `/codegen` subpath: `ContractTypeInput`, `resolveContractTypeInputs`, `generateContractTypes`.

### Breaking changes

- `@polkadot-api/sdk-ink` and its exports (`createInkSdk`, `InkSdk`, ink!-flavoured types) are removed.
- `ReviveCallTx` / `ReviveTypedApi` use `HexString` for `dest` and `Uint8Array` for `data` (PAPI 2.x). Class-based `FixedSizeBinary<20>` / `Binary` are no longer accepted.
- Node-only loaders + build-time codegen live on the `/pvm` and `/codegen` subpaths and are not exported from the main entry.
