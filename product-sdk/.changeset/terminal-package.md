---
"@parity/product-sdk-terminal": minor
---

Add `@parity/product-sdk-terminal` — Node.js wrapper for the host-papp SDK that enables QR code login, attestation, and signing in CLI/terminal apps. Migrated from `@polkadot-apps/terminal` v0.3.0.

**Breaking vs upstream:** `createSessionSigner(session)` → `createSessionSigner(session, productAccountId)`. The `@novasamatech/host-papp` 0.6→0.7 bump replaced `SigningRawRequest.address` with `productAccountId: [string, number]`. Pass `[appId, 0]` for the default account.
