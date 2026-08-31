---
"@parity/product-sdk-host": patch
---

Update `@parity/truapi` to 0.12.0. No SDK API changes: the bump is additive on
truapi's side and nothing in `@parity/product-sdk-host` consumes the new surface
yet. 0.12.0 adds the `locale` domain (`locale.subscribe`, the host's selected
language as a BCP 47 tag), `system.info` / `system.getProductContext`, and
`development_createAccountProof` for raw proof contexts. The testing fake tracks
the new surface: the `locale` domain is not modeled, and the `system` domain
still models `handshake` / `featureSupported` / `navigateTo` while the new
`info` and `getProductContext` throw the descriptive not-modeled error instead
of an `undefined is not a function`. Bumping keeps the catalog current with the
latest published client and unblocks the upcoming locale provider.
