---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

**Update `@parity/truapi` to 0.5.0 (versioned call errors, CoinPayment, Ring
VRF redesign).**

truapi 0.4 wraps every call error in its canonical `CallErrorValue`
envelope: domain failures arrive as `{ tag: "Domain", value: { tag: "V1",
value: <domain error> } }`, alongside the transport-level `Denied` /
`Unsupported` / `MalformedFrame` / `HostFailure` variants. truapi 0.5
reworks the Ring VRF surface around product-scoped proof contexts. The SDK
tracks the protocol:

- `AccountsProvider` lookup methods now carry
  `CallErrorValue<Versioned…Error>` on their `err` channel instead of the
  bare per-domain error unions.
- `HostErrorPayload` is now the `CallErrorValue` envelope itself
  (protocol-sourced, replacing the previous hand-widened union), and
  `formatHostError` / `HostCallFailedError` messages unwrap the `Domain`
  envelope down to the domain error, so rendered messages read as before.
- **Ring VRF**: `getProductAccountAlias` and `createRingVRFProof` (on
  `AccountsProvider`, `SignerManager`, and the signer's `HostProvider`)
  now take a `ProductProofContext` (`{ productId, suffix }`) plus the
  restructured `RingLocation` (`{ chainId, junctions }`) — the host
  selects the ring member key, so per-account `dotNsIdentifier` /
  `derivationIndex` addressing is gone. `createRingVRFProof` returns a
  `RingVRFProof` (`{ proof, contextualAlias, ringIndex, ringRevision }`)
  instead of bare proof bytes, carrying the values needed to verify the
  proof downstream.
- `PaymentManager` purse parameters follow truapi's rename of
  `PaymentPurseId` to `CoinPaymentPurseId` (same underlying type).
- The `createFakeTruApiClient` test fake covers the new `coinPayment`
  domain as an unmodeled (throwing) surface and the richer Ring VRF proof
  response.
