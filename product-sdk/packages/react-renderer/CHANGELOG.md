# @parity/product-sdk-react-renderer

## 0.1.0

### Minor Changes

- df6b2c0: Add `@parity/product-sdk-react-renderer`: a React renderer for TrUAPI custom
  chat message widgets, ported from `@novasamatech/product-react-renderer` with
  all novasama dependencies replaced by `@parity/truapi` types.
- df6b2c0: **Pair with a truapi 0.23.0 host.** `@parity/truapi` moves from `^0.20.0` to `^0.23.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `462dacb6e0d1f504` to `ea1a1441ff0219b1`, so the schema a product speaks no longer matches a host still on 0.20.0. Every host surface has to move in the same window.

  **Surface changes carried through `@parity/product-sdk-host`.** truapi 0.23 adds a `contacts` domain (a `getTruApi().contacts.pick` picker; modeled as not-supported by the testing fake, and product-account transactions now send an empty `contacts` list). It also dropped four type aliases the host re-exported, replaced by the primitives they always were, so no runtime change: `NotificationId` and `CoinPaymentPurseId` are `number`, payment `Balance` is `bigint`, and a statement `Topic` is a `` `0x${string}` `` hex. The `NotificationId` and `Topic` names stay exported from this package as local aliases, so importers are unaffected.
