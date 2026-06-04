---
"@parity/product-sdk-terminal": patch
---

**Fix `createSlotAccountSigner` deriving the wrong public key from a 64-byte slot account key.**

Mobile hosts return `slotAccountKey` as schnorrkel `SecretKey::to_bytes()` material —
the canonical scalar (32 bytes) concatenated with the nonce (32 bytes). `buildKeypair`
fed those 64 bytes straight into `@scure/sr25519`'s `getPublicKey`, which expects the
`to_ed25519_bytes()` form where the scalar is pre-multiplied by the cofactor (×8).
The mismatch produced a public key — and therefore an address and signatures — that
did not match the slot account the host allocated, so submissions signed by the slot
signer were rejected.

The 64-byte branch now converts the canonical scalar to the cofactor-multiplied form
before deriving, so the derived key matches the host's slot account. The 32-byte
mini-secret path is unchanged.
