---
"@parity/product-sdk-auth": minor
---

Add `@parity/product-sdk-auth` — the QR/mobile sign-in + session-signing glue, lifted from playground-cli's `src/utils/{auth,signer,sessionSigner}.ts` plus the RFC-0010 allocation helper, and refactored so all env config (dApp id, product id, derivation index, People endpoints) is injected via `createAuthClient(config)` rather than imported from a product's own `config.ts`. One shared sign-in implementation for playground-cli, bulletin-deploy, and future product CLIs.

**Public API:** `createAuthClient` / `resolveSigner` / RFC-0010 `requestResourceAllocation`, plus a `./ui` subpath (QR render + login/logout status formatters). The headless root pulls in no terminal-render code.
