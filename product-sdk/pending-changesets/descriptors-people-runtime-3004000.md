---
"@parity/product-sdk-descriptors": minor
"@parity/product-sdk": minor
---

Re-pin `paseo-individuality` and `previewnet-individuality` to the People runtime now live on both chains (`next-people-paseo` 3004000, code hash `0x69e7126f…7871`). The genesis hashes are unchanged.

What moved in the pallets products read: `Airdrop.EventInfo` gained `product_name` (so `Airdrop.Events` and `schedule_event` changed shape, with a new `InvalidProductName` error); `Game` gained the `product_name` constant and a `CreditCapacityExhausted` error; `Members` gained `RetiredIdentifiers` and `IdentifierRetired`; `NftCredits` keys awards by `(block, index)` with expiry sweeps and its runtime API arguments are named `tree_block`; the `SkipFeelessPayment` pallet is gone; `AuthorizedAliasersApi` and `TrustedQueryApi` were added. `PeopleLite`, `People`, `Score`, `Coinage` and `PeopleAirdrops` are unchanged in shape.

The runtime also declares two transaction-extension pipelines now, version 0 (plain, what a signed V4 extrinsic uses) and version 1 (the origin extensions); `@parity/product-sdk-individuality` reads the right one from this release on.
