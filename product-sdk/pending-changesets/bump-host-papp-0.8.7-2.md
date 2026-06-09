---
"@parity/product-sdk-terminal": minor
"@parity/product-sdk-host": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk-statement-store": patch
"@parity/product-sdk": minor
---

**Bump `@novasamatech/host-api` family from `^0.8.6` to `^0.8.7-2`.** Picks up the upstream `deviceEncPubKey` addition on the V2 session schema (PR #212), the statement-store allowance-slot-prover fix (PR #214 — `createSr25519Prover` → `createSlotAccountProver`), and the `ExpiryTooLow` retry fix in `submitWithRetry`.

One consumer-visible behavioral change worth flagging up front:

> **CLI consumers using `@parity/product-sdk-terminal`** — host-papp `0.8.7-1` renamed the on-disk session storage key (`SsoSessionsV2` → `SsoSessionsV3`) and added a required `deviceEncPubKey: Bytes(65)` field on the persisted session. Sessions persisted from a previous CLI run will be invisible after upgrading; users will need to re-pair their phone the first time they launch the upgraded CLI. The `UserSecretsV2_<sessionId>.json` file format is unchanged.

### What's new

**Upstream catalog bump.** `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` move from `^0.8.6` to `^0.8.7-2`. Headlines from upstream (between `release: 0.8.6 (#208)` and `chore(release): publish 0.8.7-2`):

- **`deviceEncPubKey` on the V2 session schema** (upstream PR #212). The persisted session codec gains a required `deviceEncPubKey: Bytes(65)` — the paired phone's long-lived ECDH key, lifted from `HandshakeResponseV2.deviceEncPubKey`, used by the host's device-sync channel. The storage key was renamed `SsoSessionsV2 → SsoSessionsV3` in the same release; the old graceful-degrade for V2 blobs is gone.
- **Statement-store allowance-slot-prover fix** (upstream PR #214). `AllowanceService.getStatementStoreProver` now uses `createSlotAccountProver` instead of `createSr25519Prover` — fixes a signature-scheme mismatch when proving slot-account-derived secrets. No public API change on our side (our `getStatementStoreProver` wrapper passes through unchanged), but the proofs the returned prover emits are now of the correct scheme.
- **`ExpiryTooLow` retry handling in `submitWithRetry`** (upstream `73cb870`). Internal to host-papp/statement-store retry logic; no consumer-side change.

### `@parity/product-sdk-terminal`

Internal codec mirror used by `createTestSession` updated to match host-papp 0.8.7-2's reshaped session schema:

- Appended `deviceEncPubKey: Bytes(65)` to the mirrored codec; the synthesized field reuses the remote peer's P-256 encryption pubkey (same value already used for `identityChatPublicKey` and `ssoEncPubKey`).
- Storage-key rename: `SsoSessionsV2.json` → `SsoSessionsV3.json`. The in-source unit tests and TSDoc references all updated.

No public-API change; `createTestSession`'s signature is unchanged. The interop test continues to round-trip the synthesized session through the real `SsoSessionManager` and `UserSecretRepository` to catch upstream drift early — both interop suites pass against host-papp 0.8.7-2.

### `@parity/product-sdk-host`, `@parity/product-sdk-signer`, `@parity/product-sdk-statement-store`

Patch-bumped to signal "tested against host-api(-wrapper) 0.8.7-2" via the published peer-dep / catalog resolution. No source change; runtime behavior is unchanged.

### Migration

**`@parity/product-sdk-terminal` — existing sessions need to be re-paired.** No source change required, but any sessions persisted to disk by a previous CLI run will be invisible after upgrading. host-papp 0.8.7-2 reads from `<storageDir>/<appId>_SsoSessionsV3.json`; the previous `SsoSessionsV2.json` path is no longer consulted, and the old graceful-degrade for stale blobs is gone.

What this means in practice:

- A user upgrading the CLI will see the same UX they'd see on a fresh install — `waitForSessions` returns no sessions until they complete a QR pairing.
- The old `SsoSessionsV2.json` file is not deleted, just ignored. Optional cleanup: surface a one-liner to the user ("we updated the session format, please re-pair") and `fs.unlink` the legacy path.
- The `UserSecretsV2_<sessionId>.json` file format is unchanged; legacy secrets files become orphaned (the new session has a different `sessionId`) but don't cause errors.
- Synthesized test sessions emitted by `createTestSession` automatically write to the new path — no test code change needed unless your tests asserted on the old filenames.
