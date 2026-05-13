---
"@parity/product-sdk-host": minor
---

**Add `requestResourceAllocation` to `@parity/product-sdk-host`.**

Exposes a typed wrapper around the TruAPI's resource-allocation endpoint, so consumers can pre-allocate one or more resource allowances in a single host-side user prompt. Subsequent operations covered by the granted allowance don't re-prompt the user.

### New surface

```ts
import {
    requestResourceAllocation,
    type AllocatableResource,
    type AllocationOutcome,
} from "@parity/product-sdk-host";

const outcomes = await requestResourceAllocation([
    { tag: "BulletInAllowance", value: undefined },
]);
if (outcomes[0].tag === "Allocated") {
    // allowance granted
}
```

- `AllocatableResource` and `AllocationOutcome` are derived from the upstream codecs (`@novasamatech/host-api`) via `CodecType`, so variant renames upstream surface as compile errors rather than runtime failures.
- The host strips secret payloads from `Allocated` outcomes before returning, so `value` is always `undefined` on the product side.
- Throws if the TruAPI is unavailable (consistent with the rest of the host module's accessors).

No breaking changes — purely additive.
