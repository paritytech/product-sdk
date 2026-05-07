# @parity/product-sdk-terminal

> Migrated from `@polkadot-apps/terminal` v0.3.0 (`paritytech/polkadot-apps`).

QR code login, attestation, and transaction signing for CLI/terminal apps via the Polkadot mobile wallet.

Wraps the [`@novasamatech/host-papp`](https://www.npmjs.com/package/@novasamatech/host-papp) SDK with Node.js-compatible adapters (file-based storage, WebSocket transport) so the full SSO protocol works outside the browser.

## Installation

```bash
pnpm add @parity/product-sdk-terminal
```

## Setup

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
    const signer = createSessionSigner(session, ["my-terminal-app", 0]);
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
- `appId` -- the value you passed in (re-exposed for `createSessionSigner`'s convenience overload)
- `sso` -- auth component (`.authenticate()`, `.abortAuthentication()`, status subscriptions)
- `sessions` -- session manager (signing, disconnect)
- `destroy()` -- disconnect the WebSocket and release resources. Idempotent. Suppresses `@novasamatech/statement-store`'s noisy `Statement subscription error` log for ~50 ms after the call.

### `createSessionSigner(session, productAccountIdOrAdapter): PolkadotSigner`

Creates a `PolkadotSigner` backed by a QR-paired mobile wallet session.

**Signature:** `createSessionSigner(session: UserSession, productAccountIdOrAdapter: [string, number] | TerminalAdapter): PolkadotSigner`

**Parameters:**
- `session` -- a `UserSession` from `adapter.sessions.sessions`
- `productAccountIdOrAdapter` -- either an explicit `[productId, derivationIndex]` tuple, **or** the `TerminalAdapter` itself (in which case `[adapter.appId, 0]` is inferred — pass the explicit tuple when you need a derivation index ≠ 0 or a `productId` different from the adapter's `appId`).

> **API change vs upstream:** `@novasamatech/host-papp` 0.7 replaced the wire-format `address` field with `productAccountId: [productId, derivationIndex]`. The upstream `createSessionSigner(session)` signature is **not** present in this package.

```ts
const [session] = adapter.sessions.sessions.read();

// Convenience: infers [adapter.appId, 0]
const signer = createSessionSigner(session, adapter);

// Explicit: when you need a different productId or derivation index
const signerExplicit = createSessionSigner(session, ["my-product", 3]);

await contract.publish.tx(domain, cid, { signer, origin });
```

### `renderQrCode(data, options?): Promise<string>`

Render a string as a QR code using Unicode half-block characters for terminal display.

### `createNodeStorageAdapter(appId, storageDir?): StorageAdapter`

File-based storage adapter for Node.js. Data persists in `storageDir` (defaults to `~/.polkadot-apps/`).

### `waitForSessions(adapter, timeoutMs?): Promise<UserSession[]>`

Waits for the session list to emit at least one entry, or resolves with `[]` after `timeoutMs`.

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

The adapter uses `@polkadot-api/ws-provider/node`, which internally bundles the [`ws`](https://www.npmjs.com/package/ws) package — no `globalThis.WebSocket` polyfill is required.

The bundled WebSocket is constructed without `followRedirects: true`, so endpoints behind an HTTP redirect will fail to connect. If you must point at an endpoint that does, supply the resolved URL directly via the `endpoints` option.

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
