// AES-GCM encryption helpers.
//
// Re-exports from @parity/product-sdk-crypto so the rest of the app
// imports from a local seam — easy to swap algorithms (ChaCha20-Poly1305,
// NaCl secretbox) later without touching call sites.
//
// Usage:
//   import { aesGcmEncryptText, aesGcmDecryptText } from "./lib/crypto";
//   const { ciphertext, nonce } = aesGcmEncryptText(text, key32);
//   const plaintext = aesGcmDecryptText(ciphertext, key32, nonce);
//
// Derive the 32-byte key from the active account via
// `signerManager.getProductAccount(dotNsIdentifier, 0)` or HKDF over the
// account's public key. Reference: `@parity/product-sdk-crypto` README.

export {
  aesGcmEncrypt,
  aesGcmDecrypt,
  aesGcmEncryptText,
  aesGcmDecryptText,
} from "@parity/product-sdk-crypto";
