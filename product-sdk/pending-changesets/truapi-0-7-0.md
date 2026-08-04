---
"@parity/product-sdk-host": patch
---

Update `@parity/truapi` to 0.7.0. No SDK API changes; the client is
byte-identical to 0.6.0 apart from its embedded `packageVersion` string. It
pairs with `@parity/truapi-host@0.4.0`, which requires `@parity/truapi`
`^0.7.0` and holds the actual work: a rebuilt WASM server plus host-side review
surfaces for RFC-0023 VRF transcript signing (`SignVrfReview`) and RFC-0010
per-subtree AutoSigning keys (`AutoSigningKey`). Bumping keeps products inside
the version range that hosts running truapi-host 0.4.0 resolve.
