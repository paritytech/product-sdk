---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk-statement-store": minor
---

**Track upstream rename: `@novasamatech/product-sdk` → `@novasamatech/host-api-wrapper`.**

Novasama renamed their host-API wrapper package from `@novasamatech/product-sdk` to `@novasamatech/host-api-wrapper`. The first release under the new name is `0.7.9-6` (a prerelease).

### What changed for consumers

If you install `@parity/product-sdk-host`, `@parity/product-sdk-signer`, or `@parity/product-sdk-statement-store` and were previously satisfying their optional peer dependency on `@novasamatech/product-sdk` manually, switch your direct install to `@novasamatech/host-api-wrapper` instead:

```diff
- "@novasamatech/product-sdk": "^0.7.8"
+ "@novasamatech/host-api-wrapper": "0.7.9-6"
```

Same upstream package, same exports (`hostApi`, `createAccountsProvider`, `preimageManager`, `hostLocalStorage`, etc.) — only the npm package name changed.

If you don't install the peer directly (i.e. your bundle ships without the host-side wrapper), no action needed.

### Catalog pin rationale

The new package is currently only published as `0.7.9-6` (a prerelease). The catalog is pinned to exactly `0.7.9-6` rather than `^0.7.9-6` because prerelease ranges have surprising semver semantics and prereleases can be republished. The pin will move to `^0.7.9` once a stable lands; the catalog auto-bumper (`product-sdk-deps-check.yml`) will pick that up automatically.

### Why minor

Renaming an optional peer dependency is a consumer-visible change: anyone who satisfies our peer manually needs to update their own install. Per `RELEASES.md`'s pre-1.0 convention, that ships as `minor`.
