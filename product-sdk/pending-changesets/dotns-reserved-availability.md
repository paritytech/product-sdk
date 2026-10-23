---
"@parity/product-sdk": patch
---

`isDotNsAvailable` reports a name under a live PopRules reservation as unavailable when PopRules refuses it to everyone. From DotNS 1.1.0 a reservation keeps the name off public registration for every account, its holder included, so a reserved name read as available while `prepareDotNsRegistration` failed with `NameReserved`. Up to DotNS 1.0.0 the holder may still register it, and the name stays available.
