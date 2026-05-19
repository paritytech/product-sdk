# @parity/product-sdk-storage

## 0.1.5

### Patch Changes

- Updated dependencies [4c13257]
  - @parity/product-sdk-host@0.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [bdeb144]
  - @parity/product-sdk-host@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [1cc3790]
  - @parity/product-sdk-host@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [5d81610]
- Updated dependencies [5d81610]
  - @parity/product-sdk-host@0.2.1

## 0.1.1

### Patch Changes

- 646d591: **Build + docs cleanup affecting published artifacts.**

  No public API changes. Two improvements that change shipped bytes:

  - `tsup` `treeshake: true` is now enabled across every package's build config (#48), so dead in-source vitest test code is stripped from the published bundles. Smaller install footprint with no behavior change.
  - `@packageDocumentation` blocks and TSDoc comments added across the SDK (#38), surfaced in the published `.d.ts` files for editor hover docs and the docs site.

  Packages already taking a `minor` bump in this release (`bulletin`, `chain-client`, `contracts`, `descriptors`, `host`, `keys`, `signer`, `statement-store`, `tx`, `sdk`) inherit these changes via that bump and are not listed here.

- Updated dependencies [646d591]
- Updated dependencies [646d591]
  - @parity/product-sdk-logger@0.1.1
  - @parity/product-sdk-host@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-logger@0.1.0
