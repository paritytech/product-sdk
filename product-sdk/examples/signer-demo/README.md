# @polkadot-apps/signer-demo

E2E demo app for `@polkadot-apps/signer`. Extends the
[`tx-demo`](../tx-demo/) template to cover signer-only flows: account
discovery, selection, switching, `signRaw`, permission rejection, and the
disconnect/reconnect lifecycle.

## What's exercised

- `SignerManager.connect()` against the Host API path (auto-requests
  `TransactionSubmit` permission — regression coverage for the fix shipped
  in `@polkadot-apps/signer@1.0.2`).
- `SignerManager.subscribe(state => …)` propagates state changes when the
  test host swaps the active account via `testHost.switchAccount()`.
- `SignerManager.signRaw(bytes)` round-trips through the host's
  `handleSignRaw` handler.
- Permission rejection via `testHost.setPermissionBehavior("reject-all")`
  / `revokePermission("TransactionSubmit")` — verifies the error surfaces
  cleanly through the `Result` type, not as a bare throw.
- `disconnect()` + `connect()` lifecycle from a user click.

Not covered (see [`tx-demo`](../tx-demo/README.md) caveats):

- The browser extension / standalone path — the test SDK only simulates
  the host container.
- `getProductAccount` and Ring VRF — the test SDK does route them, but
  they're product-sdk surface, not part of the signer-demo's core scope.

## Run locally

```sh
# from the repo root
pnpm install
pnpm build                              # build workspace deps

pnpm --filter @polkadot-apps/signer-demo dev   # http://localhost:5210
```

Outside the test host, `connect()` fails (no container). The demo is
driven by Playwright.

## Run E2E

```sh
pnpm exec playwright install chromium                       # once
pnpm --filter @polkadot-apps/signer-demo test:e2e           # all 4 specs
pnpm --filter @polkadot-apps/signer-demo test:e2e:ui        # debug
```

## Files

| File | Purpose |
|---|---|
| `index.html` | `data-testid`'d controls |
| `src/main.ts` | `SignerManager` lifecycle + UI bindings |
| `src/ui.ts` | `getEl`, `appendLog`, `toHex` helpers |
| `playwright.config.ts` | Vite on port 5210, workers:1, 120s timeout |
| `e2e/fixtures.ts` | Bob + Charlie on Paseo AH (override RPC via `PASEO_AH_RPC`) |
| `e2e/helpers.ts` | `waitForAppReady(testHost)` |
| `e2e/connect.spec.ts` | Boot + subscribe happy path |
| `e2e/switch-account.spec.ts` | `testHost.switchAccount()` → subscribe propagates |
| `e2e/sign-raw.spec.ts` | `signRaw` returns hex, signing log entry |
| `e2e/permission.spec.ts` | `setPermissionBehavior("reject-all")` → clean typed error |
| `e2e/lifecycle.spec.ts` | Disconnect → reconnect → sign again, no stale provider refs |
| `e2e/product-account.spec.ts` | `getProductAccount` resolves mapped + unmapped DotNS identifiers |
| `e2e/persistence.spec.ts` | Selected account survives a full page reload via `hostLocalStorage` |

## Notes for future demos

Two friction points from the `tx-demo` pilot are baked in here:

- `vite.config.ts` sets `define: { "import.meta.vitest": "undefined" }`
  so in-source vitest blocks in workspace packages don't leak top-level
  `await import(...)` into the production bundle.
- `fixtures.ts` overrides the Paseo AH RPC via `PASEO_AH_RPC` env var,
  defaulting to `sys.turboflakes.io` because `sys.ibp.network` has been
  502-flaky.
