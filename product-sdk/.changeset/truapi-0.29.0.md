---
"@parity/product-sdk": minor
"@parity/product-sdk-host": minor
"@parity/product-sdk-react-renderer": minor
"@parity/product-sdk-renderer": minor
---

**Pair with a truapi 0.29.0 host.** `@parity/truapi` moves from `^0.28.0` to `^0.29.0`. The codec version stays at 3, but `TRUAPI_WIRE_SCHEMA_HASH` moves from `1ddad8b65de84b98` to `22e6584ca33f86cd`, so the schema a product speaks no longer matches a host still on 0.28.0. Every host surface has to move in the same window.

What changed in the truapi surface, and how `@parity/product-sdk-host` absorbs it:

- **Product identifiers are branded.** The wire now types `dotNsIdentifier`, `ProductProofContext.productId`, `listRingVrfKeys`'s `owner`, `getProductContext`'s `productId` and an `NftPurseRead` permission's `Product` owner as `ProductId`, a branded string. The SDK keeps plain strings on its own surface: `ProductAccount`, `ProductAccountLookup` and `ProductProofContext` are now SDK-owned types whose `dotNsIdentifier` / `productId` stay `string`, and the host adapter brands them with `asProductId` at the wire boundary. Nothing changes for callers of `getProductAccount`, `signVrf`, `listRingVrfKeys`, `getProductAccountAlias` or `createRingVRFProof`. The one place the brand reaches product code is a `RemotePermission` built by hand for `requestPermission` with an `NftPurseRead` `Product` owner: brand that value with the newly re-exported `asProductId`; the `ProductId` type is re-exported next to it.
- **A `fundingProvider` domain joins the client**, the worker side of the funding modality: host-initiated `onAssign` / `onCancel` / `onSettleCancel` handlers plus `report` and `presentFrame`. The SDK does not model it yet. `createFakeHost()` lists it as not modeled, so touching it in a test throws a descriptive error like the other unmodeled domains.
- **`funding.request` answers with the session's `intent`** (`HostFundingResponse`) instead of nothing, and the request no longer carries a caller-chosen `id`. The SDK does not wrap `funding`, so this reaches only products calling it through `getTruApi()`.
- **Payments move to `V2`.** `payment.request` and `payment.topUp` gain an optional `funding` intent and the `AlreadyExists` / `FundingNotServed` errors; the `V1` shapes live on as `V01HostPayment*`. `getPaymentManager()` is unchanged: it never sets `funding`, and the generated client picks the version.
