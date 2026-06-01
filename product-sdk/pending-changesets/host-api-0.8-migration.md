---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk-statement-store": minor
"@parity/product-sdk": minor
---

**Migrate to `@novasamatech/host-api(-wrapper)` v0.8.**

Hosts now deliver `host-api` 0.8, and products must run a matching
`@novasamatech/host-api-wrapper` — v0.8 is wire-incompatible with v0.7.
The catalog now pins both at `^0.8.0`, and the `host` / `statement-store`
peer ranges require `>=0.8.0`. The Polkadot Module / SSO integration
(`@novasamatech/host-papp` and friends, used by
`@parity/product-sdk-terminal`) intentionally stays on 0.7.x for now, so
`terminal` is unchanged.

Breaking changes surfaced to consumers of these packages:

- **`@parity/product-sdk-host` — theme payload is now a struct.** The
  `subscribeTheme` callback (`getThemeProvider`) delivers a `ThemeMode`
  `{ name, variant }` object instead of a flat `"Light" | "Dark"` string.
  Read `theme.variant` for the light/dark value and `theme.name` for the
  theme name (`{ tag: "Default" }` or `{ tag: "Custom", value }`). New
  `ThemeVariant` and `ThemeName` types are exported.
- **`@parity/product-sdk-host` — resource-allocation tag renamed.** The
  `AllocatableResource` / `AllocatableResourceTag` value `BulletInAllowance`
  is now `BulletinAllowance`; the `RemotePermission` tag `WebRTC` is now
  `WebRtc` (pure renames from the upstream codec).
- **`@parity/product-sdk-signer` / `@parity/product-sdk-statement-store`**
  now require the v0.8 wrapper to stay wire-compatible with a v0.8 host.
