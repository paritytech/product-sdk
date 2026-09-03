---
"@parity/product-sdk-host": patch
---

Update `@parity/truapi` to 0.13.1. No SDK API changes: the client's domain
surface (`client.d.ts`) is identical to 0.12.0, so nothing in
`@parity/product-sdk-*` changes and the host testing fake needs no new modeling.
The only differing type files are truapi's own explorer / playground codegen and
`well-known-chains`, none of which the SDK imports. Bumping keeps the catalog
current with the latest published client (closes the release-bot bump issue).
