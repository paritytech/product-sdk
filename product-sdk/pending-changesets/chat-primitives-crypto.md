---
"@parity/product-sdk": minor
"@parity/product-sdk-crypto": minor
---

`@parity/product-sdk-crypto` gains `x25519PublicKey`, `x25519Keypair` and `x25519SharedSecret` (which refuses the all-zero secret of a low-order key), `sr25519SecretFromSeed`, `sr25519PublicKey`, `sr25519Sign` and `sr25519Verify` (`substrate` context, `false` on malformed input), a `key` for `blake2b256` and `blake2bHash(data, { length, key? })`, a caller-chosen `nonce` for `chachaEncrypt`, and `chachaEncryptPacked`/`chachaDecryptPacked` (`nonce(12) || ciphertext || tag`). Every module is also a subpath (`/x25519`, `/sr25519`, `/chacha`, `/hashing`, `/hkdf`, `/aes`, `/encoding`, `/nacl`), and the build emits one file per module: a worker imports from the subpaths, because the barrel reaches tweetnacl, whose Node `require("crypto")` a worker bundle cannot resolve. `@noble/ciphers` and `@noble/curves` move to 2.x.
