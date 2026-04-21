# @parity/product-sdk-tx-demo

E2E demo app for `@parity/product-sdk-tx`. This is the template for the E2E test harness pattern.

Minimal Vite + vanilla-TS app that:

- Connects a signer via `@parity/product-sdk-signer`'s `SignerManager` (auto-detects the Host API path inside the `host-api-test-sdk` test host).
- Opens a typed chain client via `@parity/product-sdk-chain-client`'s `getChainAPI("paseo")`.
- Submits `System.remark` (single + batched) via `@parity/product-sdk-tx`'s `submitAndWatch` / `batchSubmitAndWatch`.

The UI exposes `data-testid`'d controls that Playwright drives during E2E.

## Run locally

```bash
pnpm install
pnpm build

# Start the Vite dev server (http://localhost:5200)
pnpm --filter "@parity/product-sdk-tx-demo" dev
```

Running the page directly in a browser outside the test host will log "Signer connect failed" — that's expected. The app is designed to be driven through the test host; the E2E suite sets that up automatically.

## Run E2E

```bash
pnpm --filter "@parity/product-sdk-host-demo" exec playwright install chromium  # first time
pnpm --filter "@parity/product-sdk-tx-demo" test:e2e
```

The Playwright config boots Vite on port 5200 and runs the specs in `e2e/`. Tests are serial (`workers: 1`) because they share nonce state on Paseo Asset Hub.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Mounts `#app` with all `data-testid`'d controls |
| `src/main.ts` | Boot sequence: signer → chain-client → button handlers |
| `src/ui.ts` | `getEl` + `appendLog` helpers |
| `vite.config.ts` | Dev server on port 5200 |
| `playwright.config.ts` | Playwright runner pointed at Vite |
| `e2e/fixtures.ts` | `createTestHostFixture` with Bob on Paseo Asset Hub |
| `e2e/helpers.ts` | `waitForAppReady(testHost)` |
| `e2e/submit-remark.spec.ts` | Core happy-path specs |

## Caveats

- Host-side simulation is limited to what `@parity/host-api-test-sdk` ships (signing, chain RPC, accounts, localStorage). Packages whose host path uses other protocols (bulletin's `preimageManager`, statement-store's `remote_statement_store_*`) are not covered here.
- The test SDK hits real Paseo Asset Hub — expect some tail-latency flake on slow CI runs. The Playwright config retries once in CI.
