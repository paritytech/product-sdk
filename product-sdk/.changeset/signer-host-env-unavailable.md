---
"@parity/product-sdk-signer": patch
---

**`HostProvider.connect()` now returns a specific `HostUnavailableError` instead of a misleading `HostRejectedError` when the app is running outside a Polkadot host container.**

Reported externally as P0 ("`Failed to connect: Unknown. Environment is not correct`" surfaced by playground-cli's `npm run dev` flow with no way for the user to know what was wrong).

### Root cause

The upstream `@novasamatech/host-api` transport throws `Error("Environment is not correct")` synchronously inside `getLegacyAccounts()` / `getProductAccount()` when `sandboxTransport.isCorrectEnvironment()` returns false (i.e. the app isn't loaded in an iframe under Polkadot Desktop or a WebView under Polkadot Mobile — the dominant case during local `npm run dev`).

`HostProvider.tryConnect()` was catching that exception at the `getLegacyAccounts()` step and wrapping it as `HostRejectedError("Host rejected account request: Environment is not correct")` — a label that's wrong (no host rejected anything; there's no host at all) and a message that gives the user nothing actionable.

### Fix

Two layered changes, both in `HostProvider.tryConnect()`:

1. **Pre-check `sandboxTransport.isCorrectEnvironment()` between SDK load and provider creation.** If false, return `HostUnavailableError` with a specific message: *"Host API is not available: not running inside a Polkadot host container. Open this app inside Polkadot Desktop or the Polkadot Mobile WebView, or pick a non-host signer provider (e.g. dev accounts)."* The check short-circuits before any RPC call, so the user never sees the upstream exception text leak through.

2. **Safety-net re-classification at the `getLegacyAccounts()` catch.** If the upstream throws `Environment is not correct` deeper than the pre-check (older wrappers without `sandboxTransport`, or race conditions in a WebView teardown), re-classify the error as `HostUnavailableError` rather than wrapping with the misleading `Host rejected account request:` prefix.

`ProductSdkModule` gains an optional `sandboxTransport?: { isCorrectEnvironment(): boolean }` field so tests and older wrappers without the field continue to work via the safety net.

`HostUnavailableError`'s TSDoc updated to call out "running outside a host container" as the dominant cause during local development, with `instanceof`-branching guidance for consumers.

### Tests

Three new unit tests in `host.ts` (`signer` package now at 95 tests, was 92):

- `returns HOST_UNAVAILABLE with actionable guidance when not inside a host container` — exercises the pre-check; asserts `getLegacyAccounts` is never called.
- `safety net: re-classifies upstream 'Environment is not correct' as HOST_UNAVAILABLE` — exercises the catch-site re-classification for the legacy wrapper path.
- `connect proceeds when sandboxTransport reports a correct environment` — confirms the pre-check doesn't false-fail on the happy path.
