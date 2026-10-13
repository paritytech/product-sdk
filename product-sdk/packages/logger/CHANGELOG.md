# @parity/product-sdk-logger

## 0.1.2

### Patch Changes

- dde3b0d: Fix a Node.js warning (`` `--localstorage-file` was provided without a valid path ``) emitted whenever `@parity/product-sdk-logger` was imported under Node. `readEnv()` now returns `process.env[key]` unconditionally when running under Node, and never falls through to the browser-only `localStorage` read — previously it only skipped `localStorage` when the env var happened to be _set_, so any consumer running under Node with the var unset (the common case) still triggered Node's lazy `localStorage.getItem` warning.

## 0.1.1

### Patch Changes

- 646d591: **Build + docs cleanup affecting published artifacts.**

  No public API changes. Two improvements that change shipped bytes:

  - `tsup` `treeshake: true` is now enabled across every package's build config (#48), so dead in-source vitest test code is stripped from the published bundles. Smaller install footprint with no behavior change.
  - `@packageDocumentation` blocks and TSDoc comments added across the SDK (#38), surfaced in the published `.d.ts` files for editor hover docs and the docs site.

  Packages already taking a `minor` bump in this release (`bulletin`, `chain-client`, `contracts`, `descriptors`, `host`, `keys`, `signer`, `statement-store`, `tx`, `sdk`) inherit these changes via that bump and are not listed here.

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.
