// Persistent session signer (no mnemonic prompt).
//
// SessionKeyManager generates a fresh mnemonic on first use, persists it
// via `./lib/storage`'s KvStore, and derives an sr25519 account from it.
// Subsequent calls reuse the stored mnemonic, so the session signer
// survives page reloads — without ever asking the user for a seed phrase.
//
// Pair with `KeyManager` from @parity/product-sdk-keys if you also need
// HKDF-derived app-scoped keys from a one-time signature.
//
// Usage:
//   import { getSessionKey } from "./lib/keys";
//   const { account } = await getSessionKey();
//   // `account` is an sr25519 keypair ready to sign extrinsics.
//
// Reference: `keys-demo` in the @parity/product-sdk repo.

import { SessionKeyManager } from "@parity/product-sdk-keys";
import type { SessionKeyInfo } from "@parity/product-sdk-keys";
import { getStore } from "./storage";

let sessionPromise: Promise<SessionKeyInfo> | null = null;

export async function getSessionKey(): Promise<SessionKeyInfo> {
  if (!sessionPromise) {
    const store = await getStore("session-key");
    sessionPromise = new SessionKeyManager({ store }).getOrCreate();
  }
  return sessionPromise;
}
