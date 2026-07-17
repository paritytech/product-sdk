---
"@parity/product-sdk-host": minor
"@parity/product-sdk": minor
---

**Update `@parity/truapi` to 0.4.1 (versioned call errors, CoinPayment).**

truapi 0.4 wraps every call error in its canonical `CallErrorValue`
envelope: domain failures arrive as `{ tag: "Domain", value: { tag: "V1",
value: <domain error> } }`, alongside the transport-level `Denied` /
`Unsupported` / `MalformedFrame` / `HostFailure` variants. The host
package tracks the protocol:

- `AccountsProvider` lookup methods now carry
  `CallErrorValue<Versioned…Error>` on their `err` channel instead of the
  bare per-domain error unions.
- `HostErrorPayload` is now the `CallErrorValue` envelope itself
  (protocol-sourced, replacing the previous hand-widened union), and
  `formatHostError` / `HostCallFailedError` messages unwrap the `Domain`
  envelope down to the domain error, so rendered messages read as before.
- `PaymentManager` purse parameters follow truapi's rename of
  `PaymentPurseId` to `CoinPaymentPurseId` (same underlying type).
- The `createFakeTruApiClient` test fake covers the new `coinPayment`
  domain as an unmodeled (throwing) surface.
