---
"@parity/product-sdk-host": minor
"@parity/product-sdk-signer": minor
"@parity/product-sdk": minor
---

Bump `@parity/truapi` to `^0.9.0`.

0.8.0's `DerivationIndex` selector rename carries forward: `{ tag: "Left",
value: number }` becomes `{ tag: "Index", value: number }` and `{ tag:
"Right", value: HexString }` becomes `{ tag: "Raw", value: HexString }`.
Update any code constructing derivation indexes accordingly.

0.9.0 reworks the ring-VRF API around explicit key registration instead of a
host-selected member key:

- `@parity/product-sdk-host`'s `AccountsProvider.createRingVRFProof` and
  `getProductAccountAlias` both gain a required leading `keyHandle:
  ProductAccountLookup` parameter, naming the registered member key to use. A
  `ProductAccount` satisfies it, and the adapter wraps it into the wire's
  tagged selector.
- `AccountsProvider` gains three wrappers over the key registry:
  `registerRingVrfKey(index, ring)`, `listRingVrfKeys(owner, disclosure)`,
  and `ringVrfSign(keyHandle, message)`. `index` is a plain number, public
  keys and signatures come back as `Uint8Array`, and `listRingVrfKeys`
  returns the SDK-facing `RegisteredRingVrfKey` view: `publicKey` decoded to
  bytes and the handle's derivation index unwrapped to a number.
- `@parity/product-sdk-signer`'s `SignerManager.createRingVRFProof` and
  `getProductAccountAlias` (and the `HostProvider` methods backing them) gain
  the same leading `keyHandle` parameter. Key registration is not wrapped by
  `SignerManager`. Call the host package's `AccountsProvider` directly for
  `registerRingVrfKey` / `listRingVrfKeys` / `ringVrfSign`.

Update any code producing Ring VRF proofs or aliases to register a key first
and pass its handle explicitly.
