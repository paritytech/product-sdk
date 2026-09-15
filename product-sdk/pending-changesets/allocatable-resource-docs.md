---
"@parity/product-sdk-terminal": patch
---

**Name the host-papp version the module actually pins.** The `host.ts` module doc still said `0.7.7` three bumps after the fact; the package pins `0.10.0` exactly.

No behaviour change. The public shapes of `AllocatableResource` and `OnExistingAllowancePolicy` are now pinned by a type assertion in the module's test block, so a future host-papp bump that reshapes either fails typecheck naming the type instead of depending on whether this repo happens to construct the changed variant.
