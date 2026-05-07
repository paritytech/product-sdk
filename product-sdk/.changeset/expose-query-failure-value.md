---
"@parity/product-sdk-contracts": minor
---

**Surface the failure payload on `QueryResult.value`.**

A failed contract query used to return `{ success: false, value: undefined, gasRequired: undefined }` — callers had no way to tell *why* the dry-run failed. Was the contract reverting? Was the caller account unmapped? Did the call decode at all? Diagnosing it meant reaching past the SDK with manual storage probes, even though the runtime had already reported the reason on the way back.

`QueryResult<T>` is now a discriminated union:

```ts
type QueryResult<T> =
    | { success: true; value: T; gasRequired: bigint }
    | { success: false; value: unknown; gasRequired?: bigint };
```

- **Success branch** — unchanged shape; `gasRequired` is now guaranteed non-optional.
- **Failure branch** — `value` carries the raw payload the runtime returned (typically a tagged enum like `{ type: "Reverted", value: ... }` or `{ type: "Trapped", ... }`). Inspect its shape to decide how to react.

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
    handleFailure(r.value); // typed as `unknown` — narrow on shape
}
```
