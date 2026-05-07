---
"@parity/product-sdk-terminal": minor
---

**New package: `@parity/product-sdk-terminal` — QR-code login and signing for CLI/Node.js apps.**

The dev-utility / CLI escape hatch in the `product-sdk` family. Same protocol surface as the in-host SDK packages, but runs in plain Node so a developer can sign with their phone from a terminal — deploy scripts, contract publishers, attestation tools, indexers, scheduled jobs.

Wraps `@novasamatech/host-papp` with Node-compatible adapters: file-based session storage in `~/.polkadot-apps/`, a `ws-provider` transport, an ESM loader hook that redirects `verifiablejs`'s inline-WASM bundle to its `pkg-nodejs` build.

### Public surface

- `createTerminalAdapter({ appId, metadataUrl, endpoints?, hostMetadata?, storageDir? })` — builds the adapter wired up to file storage + WebSocket. Synchronous; returns a `TerminalAdapter` (extends `PappAdapter`).
- `createSessionSigner(session, adapter)` — `PolkadotSigner` for the session's default account. Use this for ~all CLI flows.
- `createSessionSignerForAccount(session, { productId, derivationIndex })` — escape hatch for non-default sub-accounts or a `productId` that differs from the adapter's `appId`.
- `waitForSessions(adapter, timeoutMs?)` — resolves with persisted sessions (loaded asynchronously from disk) or `[]` after the timeout.
- `renderQrCode(data, options?)` — Unicode half-block QR code suitable for `console.log`.
- `createNodeStorageAdapter(appId, storageDir?)` — file-based `StorageAdapter`. Wired in by `createTerminalAdapter`; exposed for advanced setups.
- Re-exports the `host-papp` types consumers need: `PappAdapter`, `HostMetadata`, `AttestationStatus`, `PairingStatus`, `UserSession`, `StoredUserSession`, `SigningPayloadRequest`, `SigningRawRequest`, `SigningPayloadResponse`.

### Setup

The `host-papp` SDK depends on `verifiablejs` whose default entry inlines WASM (browser-only). Pass the register hook via `--import` to redirect to the Node-compatible build:

```bash
node --import @parity/product-sdk-terminal/register app.js
tsx --import @parity/product-sdk-terminal/register app.ts
```

### Testing helpers — `@parity/product-sdk-terminal/testing`

`createTestSession({ appId, storageDir, ... })` writes a synthesized SCALE-encoded session to disk that round-trips through the real `host-papp` session repositories. Lets E2E tests cover session-discovery, persistence, and logout flows without needing a real phone.

The mirrored on-disk codec is *not* part of `host-papp`'s public API — an interop test (`testing.interop.test.ts`) loads a synthesized session through the real repositories on every run, and fails loudly if upstream's format drifts.

### Requires

- Node ≥21 (relies on the global `WebSocket` exposed by `@polkadot-api/ws-provider@0.9`).

### Not yet covered

- The on-chain attestation / allowance refresh flow. A paired session's allowance eventually expires and currently requires re-pairing. Tracked as a follow-up.
- A QR-pair → phone-signs → statement-store roundtrip in CI. The `--import` smoke test covers loader-hook resolution; everything past that needs a real phone.
