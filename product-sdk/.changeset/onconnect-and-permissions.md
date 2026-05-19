---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
---

**Typed permission ergonomics and an `onConnect` lifecycle hook.**

Two additive changes that collapse the boilerplate every dapp was writing on top of `hostApi.permission` and the once-per-connect side-effect pattern. No breaking changes; existing call sites keep working.

### `@parity/product-sdk-host` — `RemotePermission` types + `requestPermission` wrapper

- **`RemotePermission`, `RemotePermissionTag`, `AllocatableResourceTag`, and `AllocationOutcomeTag`** type aliases are now exported alongside the existing `AllocatableResource` / `AllocationOutcome` aliases. All derive from the `@novasamatech/host-api` SCALE codecs via `CodecType<typeof X>` so schema drift surfaces as a TypeScript error at this boundary instead of silently passing through `as never` casts.

- **`requestPermission(permission)`** builds the `v1` envelope, calls `hostApi.permission`, and unwraps the response. Returns `Promise<boolean>` and throws on host-unavailable or wire failure — matches the shape of the existing `requestResourceAllocation` so the two helpers compose consistently.

  ```ts
  const granted = await requestPermission({ tag: "ChainSubmit", value: undefined });
  if (!granted) tellUserToReconnect();
  ```

### `@parity/product-sdk-signer` — `onConnect` lifecycle hook

- **`SignerManagerOptions.onConnect`** is a new callback that fires exactly when the manager transitions to `"connected"` with a selected account — not on every subscribe notification while connected. Fires again after auto-reconnect, so a fresh host session re-runs the callback.

  The `ctx` argument exposes a pre-bound `requestResourceAllocation` helper (re-exported from `@parity/product-sdk-host`) plus an `AbortSignal` that fires if the user disconnects or destroys the manager mid-flight. Errors thrown from `onConnect` are logged but do not affect the connected state — the next reconnect retries.

  ```ts
  new SignerManager({
    onConnect: async (_account, { requestResourceAllocation, signal }) => {
      try {
        const outcomes = await requestResourceAllocation([
          { tag: "AutoSigning", value: undefined },
        ]);
        if (signal.aborted) return;
        if (outcomes.some((o) => o.tag !== "Allocated")) {
          logWarning("partial permissions", outcomes);
        }
      } catch (cause) {
        logWarning("resource allocation failed", cause);
      }
    },
  });
  ```

  Replaces ~50 lines of transition-gated subscription, once-per-session bookkeeping, and HMR cleanup that every product app was writing by hand.
