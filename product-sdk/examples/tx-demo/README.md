# @polkadot-apps/tx-demo

End-to-end demo app for `@polkadot-apps/tx`. This is the **pilot** for the E2E
test harness pattern — copy this shape to bootstrap new `<pkg>-demo` apps.

Minimal Vite + vanilla-TS app that:

- Connects a signer via `@polkadot-apps/signer`'s `SignerManager` (auto-detects
  the Host API path inside the `host-api-test-sdk` test host).
- Opens a typed chain client via `@polkadot-apps/chain-client`'s
  `getChainAPI("paseo")`.
- Submits `System.remark` (single + batched) via `@polkadot-apps/tx`'s
  `submitAndWatch` / `batchSubmitAndWatch`.

The UI exposes `data-testid`'d controls that Playwright drives during E2E.

## Run locally

```sh
# from the repo root
pnpm install
pnpm build                              # build all @polkadot-apps/* workspace deps

# start the Vite dev server (http://localhost:5200)
pnpm --filter @polkadot-apps/tx-demo dev
```

Running the page directly in a browser outside the test host will log
"Signer connect failed" — that's expected. The app is designed to be driven
through the test host; the E2E suite sets that up automatically.

## Run E2E

```sh
pnpm exec playwright install chromium   # first time only
pnpm --filter @polkadot-apps/tx-demo test:e2e
```

The Playwright config boots Vite on port 5200 and runs the specs in `e2e/`.
Tests are serial (`workers: 1`) because they share nonce state on Paseo Asset
Hub. Budget ~2 minutes per test — real chain finalization is slow.

## Files

| File | Purpose |
|---|---|
| `index.html` | Mounts `#app` with all `data-testid`'d controls |
| `src/main.ts` | Boot sequence: signer → chain-client → button handlers |
| `src/ui.ts` | `getEl` + `appendLog` helpers |
| `vite.config.ts` | Dev server on port 5200 |
| `playwright.config.ts` | Playwright runner pointed at Vite |
| `e2e/fixtures.ts` | `createTestHostFixture` with Bob on Paseo Asset Hub |
| `e2e/helpers.ts` | `waitForAppReady(testHost)` |
| `e2e/submit-remark.spec.ts` | Core happy-path specs |

## Pattern for new demos

To add `examples/<pkg>-demo`:

1. Copy this directory, rename to `<pkg>-demo`, update `package.json` name.
2. Swap the `dependencies` for the package you're demoing.
3. In `src/main.ts`, replace `submitAndWatch` wiring with your package's API.
4. Update `index.html` data-testid'd controls to match the new actions.
5. Update `e2e/submit-remark.spec.ts` (rename + rewrite) to exercise those
   actions and assert the expected chain/UI state.
6. Keep `productAccounts: { '<pkg>-demo.dot/0': 'bob' }` pointed at Bob so the
   funded dev account is always available.

## Caveats

- Host-side simulation is limited to what `@parity/host-api-test-sdk` ships
  (signing, chain RPC, accounts, localStorage). Packages whose host path uses
  other protocols (bulletin's `preimageManager`, statement-store's
  `remote_statement_store_*`) are **not** covered here.
- The test SDK hits real Paseo Asset Hub — expect some tail-latency flake on
  slow CI runs. The Playwright config retries once in CI.
