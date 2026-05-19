---
"@parity/product-sdk-keys": minor
"@parity/product-sdk": minor
---

**Add `deriveProductAccountPublicKey` + `createChainCode` to `@parity/product-sdk-keys`.**

The canonical sr25519 product-account derivation used by polkadot-desktop
(`polkadot-desktop/src/domains/product/account/service.ts`) and
polkadot-app-android-v2
(`feature/products/impl/.../ProductAccountDerivationUseCase.kt`) is now
exposed from the SDK. External clients (CLI, web hosts) can compute the
same derived address the mobile wallet derives privately, without ever
seeing the secret key. sr25519 soft derivation is composable on the
parent *public* key alone.

### New surface

```ts
import {
    createChainCode,
    deriveProductAccountPublicKey,
} from "@parity/product-sdk-keys";

// Canonical product-account derivation: junctions ["product", productId, "<index>"]
const derivedPubKey = deriveProductAccountPublicKey(
    parentPublicKey, // Uint8Array, 32-byte sr25519 public key
    "playground.dot", // productId, typically a dotNS name
    0,                // derivationIndex
);

// Lower-level helper if you need to build custom junction paths:
const chainCode = createChainCode("product"); // Uint8Array(32)
```

`createChainCode(code)` encodes a junction the way Substrate does:

- numeric `^\d+$` to SCALE `u64` (BigInt), zero-padded to 32 bytes
- string to SCALE `str` (compact-length + UTF-8), zero-padded to 32 bytes
- if the encoded form exceeds 32 bytes, `blake2b256(encoded)`

`deriveProductAccountPublicKey(parentPubKey, productId, index)` applies
`HDKD.publicSoft` left-to-right over the junctions `["product",
productId, String(index)]`. Returns the derived 32-byte public key.

### Cross-platform parity note

`productId` MUST contain at least one non-hex character OR be of odd
length when serialized as a string. polkadot-app-android-v2's
`SubstrateJunctionDecoder` tries to interpret a junction as hex BEFORE
falling through to SCALE-string encoding; polkadot-desktop and this
implementation skip that hex branch. For productIds that happen to be
even-length all-hex strings (e.g. `"deadbeef"`, `"c0ffee01"`), Android
would derive a different public key. In practice, productIds are dotNS
names like `"playground.dot"`, which contain `.` and never trip the hex
branch.

### Frozen vectors

Output is locked by four byte-for-byte test vectors in
`packages/keys/src/product-account.test.ts`, covering the production case
(`playground.dot`/0), the non-zero u64 numeric branch, a near-boundary
productId, and the blake2b fallback. Parent public keys in the vectors
are derived from deterministic 32-byte seeds via `@scure/sr25519`'s
`secretFromSeed` + `getPublicKey` (arbitrary 32-byte buffers do not work:
`HDKD.publicSoft` validates the Ristretto255 encoding at the entry
point). If polkadot-desktop's derivation algorithm ever changes, run
`packages/keys/scripts/regenerate-fixtures.ts` to re-confirm parity and
update the vectors.

### Internal: `@noble/hashes` consolidated on ^2.2.0

`@parity/product-sdk-keys` now depends on `@scure/sr25519@^2.2.0` and
`scale-ts@^1.6.1`. The workspace is also consolidated on
`@noble/hashes@^2.2.0` across `-address`, `-crypto`, `-terminal`, and
`-utils` to keep a single hash-library version in the dep tree.
Consumers see no public-API change from the noble bump (one source
file in `-address` adjusted an import path from `@noble/hashes/sha3` to
`@noble/hashes/sha3.js`; the extensionless form worked on noble 1.x but
noble 2.x's package exports require the explicit `.js` suffix).

No breaking changes here. Purely additive.
