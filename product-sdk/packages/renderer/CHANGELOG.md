# @parity/product-sdk-renderer

## 0.3.0

### Minor Changes

- 206f791: **Pair with a truapi 0.20.0 host.** `@parity/truapi` moves from `^0.18.0` to `^0.20.0`. The codec version (3) and `TRUAPI_WIRE_SCHEMA_HASH` (`462dacb6e0d1f504`) are unchanged, so products and hosts on either version still talk to each other.

## 0.2.0

### Minor Changes

- a0fcb48: Add `@parity/product-sdk-renderer`: a typed builder for renderer trees and `validateFace`, which checks a
  face against the renderer protocol without a device.

  The builders make the encoding traps unreachable — `padding(20, 24)` cannot omit an edge, and enum names
  and node shapes are checked by the compiler. `validateFace` separates what the protocol forbids from what
  it allows and you probably did not mean, and treats one host's depth, size and byte bounds as advice
  unless you name that host.

  Reachable from the umbrella as `@parity/product-sdk/renderer`.
