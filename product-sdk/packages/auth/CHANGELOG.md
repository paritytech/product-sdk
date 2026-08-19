# @parity/product-sdk-auth

## 0.2.5

### Patch Changes

- @parity/product-sdk-terminal@0.7.2
- @parity/product-sdk-keys@0.3.19
- @parity/product-sdk-tx@0.4.2

## 0.2.4

### Patch Changes

- @parity/product-sdk-keys@0.3.18
- @parity/product-sdk-terminal@0.7.1
- @parity/product-sdk-tx@0.4.1

## 0.2.3

### Patch Changes

- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
  - @parity/product-sdk-terminal@0.7.0
  - @parity/product-sdk-tx@0.4.0
  - @parity/product-sdk-keys@0.3.17

## 0.2.2

### Patch Changes

- @parity/product-sdk-keys@0.3.16
- @parity/product-sdk-terminal@0.6.2
- @parity/product-sdk-tx@0.3.2

## 0.2.1

### Patch Changes

- @parity/product-sdk-keys@0.3.15
- @parity/product-sdk-terminal@0.6.1
- @parity/product-sdk-tx@0.3.1

## 0.2.0

### Minor Changes

- cb0098f: Add `@parity/product-sdk-auth` — the QR/mobile sign-in + session-signing glue, lifted from playground-cli's `src/utils/{auth,signer,sessionSigner}.ts` plus the RFC-0010 allocation helper, and refactored so all env config (dApp id, product id, derivation index, People endpoints) is injected via `createAuthClient(config)` rather than imported from a product's own `config.ts`. One shared sign-in implementation for playground-cli, bulletin-deploy, and future product CLIs.

  **Public API:** `createAuthClient` / `resolveSigner` / RFC-0010 `requestResourceAllocation`, plus a `./ui` subpath (QR render + login/logout status formatters). The headless root pulls in no terminal-render code.

### Patch Changes

- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
  - @parity/product-sdk-terminal@0.6.0
  - @parity/product-sdk-tx@0.3.0
  - @parity/product-sdk-keys@0.3.14
