---
"@parity/product-sdk-contracts": minor
---

**Support the flattened `cdm.json` manifest shape and add live CDM registry address resolution.**

`cdm.json` is no longer bucketed by target hash. The manifest is now flat:

```jsonc
{
  "registry": "0x…",
  "dependencies": { "@org/contract-name": "latest" },
  "contracts": { "@org/contract-name": { "version": 6, "address": "0x…", "abi": [ /* … */ ] } }
}
```

- `CdmJson` loses `targets` and the per-target `dependencies` / `contracts` buckets; `dependencies` and `contracts` are now keyed directly by library name, with an optional top-level `registry` address.
- `ContractManagerOptions.targetHash` and the `CdmJsonTarget` type are removed. `ContractManager` resolves contracts directly from the flat `contracts` map.
- `ContractNotFoundError` no longer carries a `targetHash`.
- New `ContractManager.fromLive(...)` / `fromLiveClient(...)` and the standalone `withLiveContractAddresses(...)` helper strictly resolve installed contract addresses from the live CDM registry (ABIs still come from the installed snapshot). `"latest"` dependencies resolve the registry's latest address; pinned numeric dependencies resolve the installed version's address. Backed by the new `LiveContractResolutionOptions` type and `ContractLiveAddressResolutionError`.
- New exported type alias `CdmJsonDependencyVersion`.
