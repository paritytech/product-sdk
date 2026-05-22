/**
 * @parity/product-sdk-keys — Derive application keys from a user's account without touching their seed phrase.
 *
 * `KeyManager` holds a master key (typically derived from a one-time signature)
 * and produces deterministic child keys via HKDF-SHA256, so an app can scope its
 * own keys without ever asking for the user's mnemonic. `SessionKeyManager` is a
 * separate, storage-backed mechanism: it generates a fresh BIP39 mnemonic, keeps
 * it in a {@link LocalKvStore}, and derives an sr25519 account from it — useful for
 * persistent session signers. `seedToAccount` is the dev/test escape hatch that
 * turns a mnemonic and derivation path into a ready-to-use signer.
 *
 * @packageDocumentation
 */
export { KeyManager } from "./key-manager.js";
export { SessionKeyManager } from "./session-key-manager.js";
export { seedToAccount } from "./seed-to-account.js";
export { createChainCode, deriveProductAccountPublicKey } from "./product-account.js";
export type { DerivedAccount, DerivedKeypairs, SessionKeyInfo } from "./types.js";
