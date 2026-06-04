---
"@parity/product-sdk-host": patch
"@parity/product-sdk-signer": patch
"@parity/product-sdk-statement-store": patch
"@parity/product-sdk-terminal": patch
---

Bump `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, and `@novasamatech/storage-adapter` to `^0.8.5`.

0.8.5 lands SSO encryption pubkey support for Mobile SSO spec v0.2.2 — the V2 multi-device handshake now propagates `papp_encr_pub` (the peer's 65-byte uncompressed P-256 encryption key) through the V2 handshake state and persists it in `userSessionRepository`'s stored-session codec. None of host-papp's consumer-facing APIs (`createPappAdapter`, `OnAuthSuccess` shape) gain required fields, so the bump is non-breaking for callers.

`host-api` and `host-api-wrapper` had no source changes in 0.8.5 (lockstep version tag only) — `host`, `signer`, and `statement-store` are patch-bumped to signal "tested against 0.8.5" via the published peer-dep / catalog resolution; their runtime behavior is unchanged.

The terminal package mirrors host-papp's internal `storedUserSessionCodec` for its node-side `createTestSession` helper; that mirror is updated to add the new optional `ssoEncPubKey: Option(Bytes(65))` field so encoded test sessions decode against the real 0.8.5 `SsoSessionManager`. The synthesized session sets `ssoEncPubKey: undefined` (pre-v0.2.2 peer).

No public-API change in any of the four packages. Consumers don't need to do anything.
