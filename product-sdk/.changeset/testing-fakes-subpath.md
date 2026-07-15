---
"@parity/product-sdk-contracts": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-local-storage": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk-statement-store": minor
"@parity/product-sdk": minor
---

**Ship dev-only test fakes under a new `/testing` subpath on each package.**

Each package now exports a working in-memory fake of its interface from a
dedicated `/testing` entry, so SDK-dependent app code can be unit-tested with no
host container, chain, or wallet:

- `@parity/product-sdk-local-storage/testing` — `createFakeHostLocalStorage`
- `@parity/product-sdk-signer/testing` — `createFakeSignerProvider`, `fakeSignerAccount`
- `@parity/product-sdk-statement-store/testing` — `createFakeStatementTransport`
- `@parity/product-sdk-contracts/testing` — `createFakeContractRuntime`, `fakeDryRunResult`
- `@parity/product-sdk-host/testing` — `createFakeTruApiClient`, `createFakeHost`, `setTruApiClient`
- `@parity/product-sdk/testing` — `createFakeApp`, plus re-exports of the
  local-storage, signer, contracts, and host fakes

The fakes are framework-agnostic, live behind separate build entries, and are
absent from every package's main entry, so production bundles are unaffected.
`@parity/product-sdk-host` additionally gains a module-level test seam
(`setTruApiClient`, exposed only through `/testing`) that the host accessors
consult before the sandbox client; it defaults to `null`, so production
behavior is unchanged.

See the new "Testing your app" guide in the docs for usage.
