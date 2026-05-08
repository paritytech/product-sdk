# @parity/product-sdk-terminal

> Migrated from `@polkadot-apps/terminal` v0.3.0 (`paritytech/polkadot-apps`).

QR code login, attestation, and transaction signing for CLI/terminal apps via the Polkadot mobile wallet.

Wraps the [`@novasamatech/host-papp`](https://www.npmjs.com/package/@novasamatech/host-papp) SDK with Node.js-compatible adapters (file-based storage, WebSocket transport) so the full SSO protocol works outside the browser.

## Installation

```bash
pnpm add @parity/product-sdk-terminal
```

## Setup

**Requires Node ≥21.** The package relies on the global `WebSocket` exposed by Node 21+ (via `@polkadot-api/ws-provider@0.9`). On older Node versions the WebSocket connection fails at runtime with `WebSocket is not defined`.

**Register the WASM loader** — the host-papp SDK depends on `verifiablejs` which uses inline WASM (browser-only). The register hook redirects it to the Node.js WASM build. Pass it via `--import`:

```bash
node --import @parity/product-sdk-terminal/register app.js
tsx --import @parity/product-sdk-terminal/register app.ts
```

Or in your `package.json` scripts:

```json
{
    "scripts": {
        "start": "tsx --import @parity/product-sdk-terminal/register index.ts"
    }
}
```

## Quick Start

```ts
import { createTerminalAdapter, renderQrCode, waitForSessions } from "@parity/product-sdk-terminal";

// 1. Create the adapter
const adapter = createTerminalAdapter({
    appId: "my-terminal-app",
    metadataUrl: "https://example.com/metadata.json",
});

// 2. Subscribe to pairing status to show the QR code
adapter.sso.pairingStatus.subscribe(async (status) => {
    if (status.step === "pairing") {
        console.log(await renderQrCode(status.payload));
        console.log("Scan with the Polkadot mobile app...");
    }
});

// 3. Authenticate (QR pairing + on-chain attestation)
const result = await adapter.sso.authenticate();

result.match(
    (session) => console.log("Logged in!", session?.id),
    (error) => console.error("Failed:", error.message),
);

// 4. Wait for sessions to load (they load asynchronously from disk)
const sessions = await waitForSessions(adapter, 2000);

// 5. Sign messages via the paired wallet
if (sessions.length > 0) {
    const session = sessions[0];
    const signer = createSessionSigner(session, adapter);
    // use signer with polkadot-api transactions
}
```

## API

### `createTerminalAdapter(options): TerminalAdapter`

Creates a terminal adapter backed by the host-papp SDK.

**Options:**
- `appId` -- unique app identifier (used as storage namespace)
- `metadataUrl` -- URL to metadata JSON shown during pairing
- `endpoints?` -- statement store WebSocket endpoints (defaults to Paseo)
- `hostMetadata?` -- optional host environment info
- `storageDir?` -- override the on-disk session directory (defaults to `~/.polkadot-apps/`). Useful in tests and containerised environments.

**Returns** a `TerminalAdapter` with:
- `appId` -- the value you passed in (re-exposed so `createSessionSigner` can pull the productId from the adapter)
- `sso` -- auth component (`.authenticate()`, `.abortAuthentication()`, status subscriptions)
- `sessions` -- session manager (signing, disconnect)
- `destroy()` -- disconnect the WebSocket and release resources. Idempotent. Suppresses `@novasamatech/statement-store`'s noisy `Statement subscription error` log for ~50 ms after the call.

### `createSessionSigner(session, adapter): PolkadotSigner`

Creates a `PolkadotSigner` backed by a QR-paired mobile wallet session, using the session's **default account** (`derivationIndex: 0`) under the adapter's `appId`. This is the right entry point for ~all CLI flows.

```ts
const [session] = adapter.sessions.sessions.read();
const signer = createSessionSigner(session, adapter);
await contract.publish.tx(domain, cid, { signer, origin });
```

### `createSessionSignerForAccount(session, ref): PolkadotSigner`

Escape hatch for signing as a non-default sub-account of a paired session, or as a `productId` that differs from the adapter's `appId`. Most callers don't need this.

`ref` is `{ productId: string; derivationIndex: number }`:
- `productId` -- dotNS-style identifier of the requesting product. In normal usage this equals the adapter's `appId`; pass a different value only if you have an explicit reason.
- `derivationIndex` -- BIP32-style child-key index. `0` is the default account; non-zero indices reach additional sub-accounts derived from the same root.

```ts
const subSigner = createSessionSignerForAccount(session, {
    productId: "my-product",
    derivationIndex: 3,
});
```

> **Wire format note:** `@novasamatech/host-papp` 0.7 expects `productAccountId: [productId, derivationIndex]` in `SigningRawRequest`. Both functions above hide that tuple — pass an adapter for the default case or a named-fields object for the escape hatch.

### `renderQrCode(data, options?): Promise<string>`

Render a string as a QR code using Unicode half-block characters for terminal display.

### `createNodeStorageAdapter(appId, storageDir?): StorageAdapter`

File-based storage adapter for Node.js. Data persists in `storageDir` (defaults to `~/.polkadot-apps/`).

### `waitForSessions(adapter, timeoutMs?): Promise<UserSession[]>`

Waits for the session list to emit at least one entry, or resolves with `[]` after `timeoutMs`.

## Migration from `@polkadot-apps/terminal`

For consumers moving from `@polkadot-apps/terminal` v0.2.0 / v0.3.0. Existing sessions on disk (`~/.polkadot-apps/`) carry over — same `appId`, same path. No re-pairing required for the migration itself.

| Concern | `@polkadot-apps/terminal` | `@parity/product-sdk-terminal` |
| --- | --- | --- |
| Package name | `@polkadot-apps/terminal` | `@parity/product-sdk-terminal` |
| Register import path | `--import @polkadot-apps/terminal/register` | `--import @parity/product-sdk-terminal/register` |
| `createTerminalAdapter` | `async` — returned `Promise<TerminalAdapter>` | **sync** — returns `TerminalAdapter` directly. Drop the `await`. |
| Default account signer | `createSessionSigner(session)` | `createSessionSigner(session, adapter)` — pass the adapter as second arg |
| Non-default sub-account signer | not exposed | `createSessionSignerForAccount(session, { productId, derivationIndex })` |
| Override session storage dir | not supported (hard-coded `~/.polkadot-apps/`) | `createTerminalAdapter({ ..., storageDir })` option |
| E2E test helper for sessions | none | `createTestSession` from `@parity/product-sdk-terminal/testing` |
| Node version | any (bundled `ws`) | **≥21** (uses global `WebSocket`) |
| `destroy()` shutdown noise | emitted `Statement subscription error` to stderr | suppressed; `console.error` muted for ~50 ms |

### Why the signer API changed

`@novasamatech/host-papp` 0.7 replaced `SigningRawRequest.address` with `productAccountId: [productId, derivationIndex]`. The wire format requires both fields, so a session-only argument is no longer enough — the signer needs to know *which sub-account of which product is asking*. We split that into two functions to keep the common case ergonomic:

- `createSessionSigner(session, adapter)` for the default account (uses `[adapter.appId, 0]`)
- `createSessionSignerForAccount(session, { productId, derivationIndex })` for everything else

The single-argument `createSessionSigner(session)` from `@polkadot-apps/terminal` no longer works against host-papp 0.7 regardless of which package you use.

### Migration steps

1. **Replace the dep**: `pnpm remove @polkadot-apps/terminal && pnpm add @parity/product-sdk-terminal`
2. **Update the `--import` flag** in your `node` / `tsx` invocations or `package.json` scripts.
3. **Drop `await`** in front of `createTerminalAdapter(...)` calls.
4. **Update each `createSessionSigner` call site**: change `createSessionSigner(session)` → `createSessionSigner(session, adapter)`.
5. **Verify Node version** is ≥21 (`node --version`).

If your existing sessions don't appear after migrating, double-check that the `appId` is identical to what you used in `@polkadot-apps/terminal` — the on-disk file names depend on it.

## Testing

The `@parity/product-sdk-terminal/testing` subpath exports `createTestSession`, a helper that synthesizes a valid persisted session on disk. E2E tests can inject a known-good session without going through QR pairing + attestation:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalAdapter, waitForSessions } from "@parity/product-sdk-terminal";
import { createTestSession } from "@parity/product-sdk-terminal/testing";

const storageDir = mkdtempSync(join(tmpdir(), "e2e-"));
const { sessionId } = await createTestSession({
    appId: "my-terminal-app",
    storageDir,
});

const adapter = createTerminalAdapter({
    appId: "my-terminal-app",
    metadataUrl: "https://example.com/metadata.json",
    storageDir,
});
const sessions = await waitForSessions(adapter);
// sessions[0].id === sessionId
```

**Limits and usage notes.**

- **Signing does not round-trip.** `session.signRaw` goes out over the statement store and expects a real phone to respond. Use this helper for flows that test session discovery, persistence, and logout — not happy-path signing.
- **Expiry tests still work.** The synthesized local account was never registered on the People chain, so any statement-store write from this session fails with `NoAllowanceError`. That's the same error the CLI sees when a previously valid session's on-chain attestation has expired.
- **No `expiresAt` option.** The on-disk codec has no expiry field; validity lives on chain.
- **Corrupted-session cases** don't need a helper — `fs.writeFile("<storageDir>/<appId>_SsoSessions.json", "not-hex")` from the test is enough.

## Signing

After login and attestation, the paired wallet can sign messages via the statement store.

**`signRaw`** works end-to-end: the wallet receives the request, shows a prompt, and returns the signature.

**`signPayload`** (for signing transaction payloads) is not yet functional — the request is submitted but the wallet does not respond. This is a known limitation of the current wallet/protocol version.

## Notes

### WebSocket transport

The adapter uses `@polkadot-api/ws-provider@0.9`, which relies on the global `WebSocket` exposed by Node ≥21. Older Node versions (18, 20) will fail at connect time with `WebSocket is not defined` — upgrade Node, or pass an explicit `websocketClass` from the [`ws`](https://www.npmjs.com/package/ws) package.

The default WebSocket is constructed without `followRedirects: true`, so endpoints behind an HTTP redirect will fail to connect. If you must point at an endpoint that does, supply the resolved URL directly via the `endpoints` option.

### `ExperimentalWarning: Importing WebAssembly module instances`

You'll see this warning at startup:

```
(node:NNNNN) ExperimentalWarning: Importing WebAssembly module instances is an experimental feature and might change at any time
```

It's emitted by Node when the loader hook imports the `verifiablejs` WASM. Harmless. To silence it, run with `--no-warnings=ExperimentalWarning`.

## How It Works

1. **QR Pairing** -- generates Sr25519 + P256 keypairs, encodes a `polkadotapp://pair?handshake=0x...` deep link, subscribes to the statement store
2. **Attestation** -- registers the local account on the People chain so it can publish statements
3. **Signing** -- sends encrypted signing requests to the wallet via the statement store, receives signed responses

Sessions are persisted to `~/.polkadot-apps/` and survive across restarts. The SDK loads them asynchronously on startup — subscribe to `adapter.sessions.sessions` and wait for the first emission.

## Dependencies

- `@novasamatech/host-papp` -- Polkadot host-product SDK (auth, attestation, signing)
- `@novasamatech/statement-store` -- statement store client and session management
- `@novasamatech/storage-adapter` -- storage interface
- `@polkadot-api/ws-provider` -- WebSocket JSON-RPC provider
- `neverthrow` -- Result type for error handling
- `qrcode` -- QR code generation

## Future Work

- **`KvStore`↔`StorageAdapter` bridge.** This package implements its own file-backed `StorageAdapter` for Node.js (`createNodeStorageAdapter`). Once `@parity/product-sdk-storage` grows a file backend with the same `read/write/clear/subscribe` `ResultAsync` shape, replace `node-storage.ts` with a thin adapter over it.
- **Codec re-exports from `@parity/product-sdk-statement-store`.** `testing.ts` imports session-account codec helpers (`AccountIdCodec`, `LocalSessionAccountCodec`, etc.) directly from `@novasamatech/statement-store`. Re-exporting them through the in-monorepo wrapper would let this package depend only on workspace siblings.
- **Embedded host runner for allowance / attestation refresh.** Today this package consumes a paired session and signs against it, but cannot renew the on-chain attestation that gates allowance writes — once it expires the user has to re-do the full QR pairing. The proposed fix is a new `./host` sub-export (in addition to `.`, `./register`, `./testing`) exposing roughly:
  ```ts
  // proposed shape — not yet implemented
  export interface AllowanceManager {
      isExpired(): boolean;
      refresh(): ResultAsync<void, Error>;
      currentAttestation(): ResultAsync<Attestation, Error>;
  }
  export function createAllowanceManager(
      adapter: TerminalAdapter,
      options?: { hostEndpoint?: string },
  ): AllowanceManager;
  ```
  Implementation should sit on top of `@parity/product-sdk-host`'s container/storage primitives so the host runner is shared with browser/desktop hosts rather than being CLI-specific. This is the gap Tarik flagged as "the CLI might also need to run some kind of host to get allowances".
- **`@noble/*` major version drift.** This package pins `@noble/{ciphers,curves,hashes}: ^2.x` because upstream `@polkadot-apps/terminal` did, and the `testing.ts` codec helpers use the v2 import paths (`@noble/hashes/blake2.js`, `@noble/curves/nist.js`). The rest of the monorepo is on `^1.x`. Both majors coexist in the lockfile; not a runtime problem today but worth a coordinated bump. Either move the whole monorepo to v2, or rewrite `testing.ts` against v1 paths (`@noble/hashes/blake2b.js` etc.).
