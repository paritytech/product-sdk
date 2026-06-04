---
"@parity/product-sdk-terminal": patch
---

Bump `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, and `@novasamatech/storage-adapter` to `^0.8.5`.

0.8.5 lands SSO encryption pubkey support for Mobile SSO spec v0.2.2 — the V2 multi-device handshake now propagates `papp_encr_pub` (the peer's 65-byte uncompressed P-256 encryption key) through the V2 handshake state and persists it in `userSessionRepository`'s stored-session codec. None of host-papp's consumer-facing APIs (`createPappAdapter`, `OnAuthSuccess` shape) gain required fields, so the bump is non-breaking for callers.

The terminal package mirrors host-papp's internal `storedUserSessionCodec` for its node-side `createTestSession` helper; that mirror is updated to add the new optional `ssoEncPubKey: Option(Bytes(65))` field so encoded test sessions decode against the real 0.8.5 `SsoSessionManager`. The synthesized session sets `ssoEncPubKey: undefined` (pre-v0.2.2 peer).

No public-API change in `@parity/product-sdk-terminal`. Consumers don't need to do anything.
