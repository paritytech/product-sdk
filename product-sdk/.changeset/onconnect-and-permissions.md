---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
---

**Typed permission ergonomics and an `onConnect` lifecycle hook.**

Three additive changes that collapse the boilerplate every dapp was writing on top of `hostApi.requestResourceAllocation` and `hostApi.permission`. No breaking changes; existing call sites keep working.

### `@parity/product-sdk-host` — type aliases + wrappers

- **TypeScript type aliases** derived from the `@novasamatech/host-api` SCALE codecs are now exported:
  - `AllocatableResource`, `AllocatableResourceTag`
  - `AllocationOutcome`, `AllocationOutcomeTag`
  - `RemotePermission`, `RemotePermissionTag`

  Stops consumers re-declaring these inline. Schema drift in upstream codecs now surfaces as a TypeScript error at this boundary rather than silently flowing through `as never` casts.

- **`requestProductPermissions(resources)`** builds the `v1` envelope, calls `hostApi.requestResourceAllocation`, and unwraps the response. Returns `Promise<Result<AllocationOutcome[], string>>`. Outcomes are positionally aligned with the request — inspect each outcome's `tag` individually.

- **`requestPermission(permission)`** is the symmetric wrapper for `hostApi.permission`. Returns `Promise<Result<boolean, string>>`.

  Both wrappers surface a typed error for unrecognized version tags, so a future host bump can't silently drop responses. They fall back to a clean `{ ok: false, error: "Host API unavailable" }` when the host is missing.

- **`formatHostError(error)`** is now exported. Recursively unwraps the `{ tag: "v1", value: <inner> }` error shape, surfacing inner Error name+message under the outer tag — diagnostic enough to spot codec drift instead of just `"v1"`. Was previously private to `@parity/product-sdk-signer` and has been moved here so both packages share one implementation.

### `@parity/product-sdk-signer` — `onConnect` lifecycle hook

- **`SignerManagerOptions.onConnect`** is a new callback that fires exactly when the manager transitions to `"connected"` with a selected account — not on every subscribe notification while connected. Fires again after auto-reconnect, so a fresh host session re-runs the callback.

  The `ctx` argument exposes a pre-bound `requestPermissions` helper plus an `AbortSignal` that fires if the user disconnects or destroys the manager mid-flight. Errors thrown from `onConnect` are logged but do not affect the connected state — the next reconnect retries.

  ```ts
  new SignerManager({
    onConnect: async (account, { requestPermissions, signal }) => {
      const result = await requestPermissions([
        { tag: "SmartContractAllowance", value: account.derivationIndex },
        { tag: "AutoSigning", value: undefined },
      ]);
      if (!result.ok || result.value.some(o => o.tag !== "Allocated")) {
        captureWarning("partial permissions", result);
      }
    },
  });
  ```

  Replaces ~50 lines of transition-gated subscription, once-per-session bookkeeping, and HMR cleanup that every product app was writing by hand.

- **`formatHostError`** that the signer's host provider used internally now imports from `@parity/product-sdk-host`. No behavior change.
