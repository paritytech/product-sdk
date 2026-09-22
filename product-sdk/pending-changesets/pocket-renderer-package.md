---
"@parity/product-sdk-renderer": minor
"@parity/product-sdk": minor
---

Add `@parity/product-sdk-renderer`: a typed builder for renderer trees and `validateFace`, which checks a
face against the renderer protocol without a device.

The builders make the encoding traps unreachable — `padding(20, 24)` cannot omit an edge, and enum names
and node shapes are checked by the compiler. `validateFace` separates what the protocol forbids from what
it allows and you probably did not mean, and treats one host's depth, size and byte bounds as advice
unless you name that host.

Reachable from the umbrella as `@parity/product-sdk/renderer`.
