---
"@parity/product-sdk-contracts": minor
---

Default contract `.query()` and `.tx()` / `.prepare()` sizing dry-runs to best-block, with per-call `at` overrides on all three.

**Default changed**: existing `.query()` callers without an explicit `at` option now read best-block state (was `finalized`, via PAPI's default). Pass `{ at: "finalized" }` per call or set the factory default to keep the old behavior.

`createContractRuntime` and `createContractRuntimeFromClient` now accept `{ at }`,
defaulting to `"best"` so reads observe the same state as transactions resolved
at best-block. `QueryOptions.at`, `TxOptions.at`, and `PrepareOptions.at` each
override the runtime default per call, accepting `"best"`, `"finalized"`, or a
block hash. `TxOptions.at` / `PrepareOptions.at` is a no-op when both `gasLimit`
and `storageDepositLimit` are supplied (the dry-run is skipped entirely).

```ts
const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub, { at: "best" });

await counter.getCount.query();                       // best-block (default)
await counter.getCount.query({ at: "finalized" });    // finalized override
await counter.getCount.query({ at: blockHash });      // pin to a block

await counter.increment.tx({ at: "finalized" });      // size the dry-run against finalized
await counter.increment.prepare({ at: blockHash });   // pin the batched call's sizing dry-run
```
