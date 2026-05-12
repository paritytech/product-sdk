---
"@parity/product-sdk-contracts": minor
---

**Surface the failure payload on `QueryResult.value`.**

A failed contract query used to return `{ success: false, value: undefined, gasRequired: undefined }` — callers had no way to tell *why* the dry-run failed. Was the contract reverting? Was the caller account unmapped? Did the call decode at all? Diagnosing it meant reaching past the SDK with manual storage probes, even though the runtime had already reported the reason on the way back.

`QueryResult<T>` is now a discriminated union:

```ts
type QueryResult<T> =
    | { success: true; value: T; gasRequired: Weight }
    | { success: false; value: unknown; gasRequired?: Weight };
```

- **Success branch** — `gasRequired` is now guaranteed non-optional (was `Weight | undefined`).
- **Failure branch** — `value` carries the dispatch-error payload `pallet-revive` returned. Typically narrows as a tagged enum (`{ type: "Module", value: ... }`, `{ type: "ContractReverted" }`, `{ type: "AccountNotMapped" }` — see the Revive pallet error variants). `gasRequired` stays populated when the runtime reported a weight; it's optional because some failure modes don't carry one.

### Breaking changes

Type-level only. Runtime behavior on the success path is unchanged.

- Reading `.value` without first narrowing on `.success` now produces a TypeScript error — the failure branch widens it to `unknown`. The old type let this compile, but `.value` was `undefined` at runtime on failure, so any read outside an `if (success)` branch was already a latent bug.
- Constructing a `QueryResult<T>` literal in user code (mocks, tests) now requires `gasRequired` on the success branch.
- `QueryResult` is a `type` alias, not an `interface` — declaration merging no longer works.

### Migration

If your code reads `r.value` without first checking `if (r.success)`, add the narrowing. Code that was already narrowing keeps working unchanged.

```ts
// Before — compiled, but `r.value` was `undefined` at runtime on failure:
const r = await contract.query.foo();
processResponse(r.value);

// After:
const r = await contract.query.foo();
if (r.success) {
    processResponse(r.value);
} else {
    // r.value is `unknown` — narrow on the dispatch-error shape:
    if (
        typeof r.value === "object" &&
        r.value !== null &&
        "type" in r.value &&
        r.value.type === "ContractReverted"
    ) {
        handleRevert();
    } else {
        handleOtherFailure(r.value);
    }
}
```
