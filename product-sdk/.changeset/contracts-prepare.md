---
"@parity/product-sdk-contracts": patch
---

**Add `.prepare()` for batching contract calls.**

Each method on a `Contract<C>` handle now exposes a `.prepare()` companion to `.tx()` that returns a `BatchableCall` consumable by `batchSubmitAndWatch` from `@parity/product-sdk-tx`. Lets consumers group multiple contract calls (or contract calls mixed with other transactions on the same chain) into a single atomic `Utility.batch_all` extrinsic.

```ts
import { batchSubmitAndWatch } from "@parity/product-sdk-tx";

const a = contract.transfer.prepare(addr1, 100n);
const b = contract.transfer.prepare(addr2, 200n);
await batchSubmitAndWatch([a, b], api, signer);
```

`PrepareOptions` is a subset of `TxOptions` — accepts `origin`, `value`, `gasLimit`, `storageDepositLimit`. Signer and submission lifecycle options (`signer`, `waitFor`, `timeoutMs`, `mortalityPeriod`, `onStatus`) are intentionally absent — those belong to the batch submission, not the individual prepared call.

`prepare()` doesn't require a signer: the resolved origin is used purely for dry-run gas estimation, and the batch submission's signer replaces it as the dispatched origin at submission time.

Ports the `polkadot-apps` commit `4b60d19` ("feat(contracts): add `.prepare()` for batching contract calls") that never made it into this monorepo.

### New surface

- `Contract<C>[K]["prepare"]` method on every wrapped ABI function.
- `PrepareOptions` interface — re-exported from `index.ts`.
- `BatchableCall` re-exported from `@parity/product-sdk-tx` through `index.ts` (single source of truth, matches the source).

### Type fix

- `CdmJsonContract.metadataCid` is now **optional**. Real-world cdm.json files (e.g. `paritytech/playground-cli/cdm.json`) often omit it, and the runtime never reads it — only `version`, `address`, and `abi` are load-bearing for `getContract()`. This unblocks consumers whose cdm.json doesn't include a metadata CID.

### Tests added

- 6 `prepare`-specific tests in `wrap.ts` (ported from `polkadot-apps@4b60d19`)
- 8 `ContractManager` tests in `manager.ts` covering the cdm.json resolution flow against the real `paritytech/playground-cli/cdm.json` structure. The previous 0.2.0 release shipped without any `manager.ts` tests; these close that gap.

Pure addition; no breaking changes.

Test count: 55 → 69.
