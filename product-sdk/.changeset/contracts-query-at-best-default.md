---
"@parity/product-sdk-contracts": minor
---

Default contract `.query()` dry-runs to best-block, with a per-call `at` override.

`createContractRuntime` and `createContractRuntimeFromClient` now accept `{ at }`,
defaulting to `"best"` so reads observe the same state as transactions resolved
at best-block. `QueryOptions.at` overrides the runtime default per call,
accepting `"best"`, `"finalized"`, or a block hash.

```ts
const runtime = createContractRuntimeFromClient(client, paseo_asset_hub, { at: "best" });
await counter.getCount.query();                       // best-block (default)
await counter.getCount.query({ at: "finalized" });    // finalized override
await counter.getCount.query({ at: blockHash });      // pin to a block
```
