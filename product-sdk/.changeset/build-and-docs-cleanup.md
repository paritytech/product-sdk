---
"@parity/product-sdk-address": patch
"@parity/product-sdk-crypto": patch
"@parity/product-sdk-logger": patch
"@parity/product-sdk-storage": patch
"@parity/product-sdk-utils": patch
---

**Build + docs cleanup affecting published artifacts.**

No public API changes. Two improvements that change shipped bytes:

- `tsup` `treeshake: true` is now enabled across every package's build config (#48), so dead in-source vitest test code is stripped from the published bundles. Smaller install footprint with no behavior change.
- `@packageDocumentation` blocks and TSDoc comments added across the SDK (#38), surfaced in the published `.d.ts` files for editor hover docs and the docs site.

Packages already taking a `minor` bump in this release (`bulletin`, `chain-client`, `contracts`, `descriptors`, `host`, `keys`, `signer`, `statement-store`, `tx`, `sdk`) inherit these changes via that bump and are not listed here.
