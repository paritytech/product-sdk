# @parity/product-sdk-keys API Reference

> **`SS58String`** is a branded `string` type from `@parity/product-sdk-address`.

## KeyManager

Hierarchical key manager. Holds a 32-byte master key in memory and derives child keys via HKDF-SHA256.

```ts
import { KeyManager } from "@parity/product-sdk-keys";
```

### Static Constructors

#### fromSignature

```ts
static fromSignature(
  signature: Uint8Array | string,
  signerAddress: string,
  options?: { salt?: string },
): KeyManager
```

Create from a cryptographic signature. Derives master key via HKDF-SHA256.

#### fromRawKey

```ts
static fromRawKey(masterKey: Uint8Array): KeyManager
```

Create from raw 32-byte key material.

### Instance Methods

#### deriveSymmetricKey

```ts
deriveSymmetricKey(context: string): Uint8Array
```

Derive a 32-byte symmetric key for a given context string.

#### deriveAccount

```ts
deriveAccount(context: string, ss58Prefix?: number): DerivedAccount
```

Derive a Substrate sr25519 account for a given context string.

#### deriveKeypairs

```ts
deriveKeypairs(): DerivedKeypairs
```

Derive NaCl encryption (Curve25519) and signing (Ed25519) keypairs.

#### exportKey

```ts
exportKey(): Uint8Array
```

Export the raw master key bytes for persistence.

---

## SessionKeyManager

Manages an sr25519 account derived from a BIP39 mnemonic, with persistence via a `LocalKvStore`.

```ts
import { SessionKeyManager } from "@parity/product-sdk-keys";
import { createLocalKvStore } from "@parity/product-sdk-local-storage";
```

### Constructor

```ts
new SessionKeyManager(options: {
  store: LocalKvStore;
  name?: string;
})
```

### Methods

#### create

```ts
create(): Promise<SessionKeyInfo>
```

Create a new session key from a fresh mnemonic. Overwrites any existing key.

#### get

```ts
get(): Promise<SessionKeyInfo | null>
```

Load an existing session key. Returns `null` if none stored.

#### getOrCreate

```ts
getOrCreate(): Promise<SessionKeyInfo>
```

Load existing or create a new session key. Idempotent.

#### fromMnemonic

```ts
fromMnemonic(mnemonic: string): SessionKeyInfo
```

Derive from an explicit mnemonic. No storage interaction.

#### clear

```ts
clear(): Promise<void>
```

Clear the stored mnemonic.

---

## seedToAccount

Derive a `DerivedAccount` from a BIP39 mnemonic phrase.

```ts
import { seedToAccount } from "@parity/product-sdk-keys";

function seedToAccount(
  mnemonic: string,
  derivationPath?: string,
  ss58Prefix?: number,
  keyType?: "sr25519" | "ed25519",
): DerivedAccount
```

---

## deriveProductAccountPublicKey

RFC-0022 product-account public-key derivation, matching `host_logic/product_account.rs` in host-rust-core and both mobile hosts.

```ts
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";

function deriveProductAccountPublicKey(
  productSubtreePublicKey: Uint8Array,
  derivationIndex: DerivationIndex,
): Uint8Array
```

A product account sits at `//product//{productId}/{derivationIndex}`. The two `//product//{productId}` junctions are **hard**, so no public key can reach across them: `productSubtreePublicKey` must come from the Account Holder, and a root account public key will not do. Only the final index step is soft, which is what lets a paired host derive accounts locally.

Get it from `getProductSubtreePublicKey` in `@parity/product-sdk-terminal`, which fetches once per product and caches. In a CLI, prefer terminal's `deriveProductPublicKey(session, ref)`, which does both steps.

`DerivationIndex` comes from `@parity/product-sdk-utils`:

```ts
type DerivationIndex =
  | { tag: "Index"; value: number }   // u32 LE ++ blake2b256("product-account-index")[..28]
  | { tag: "Raw"; value: Uint8Array }; // 32 bytes, verbatim
```

Cross-checked against the host's own vector in `truapi-server/tests/wasm_crypto_vectors.rs`; `packages/keys/src/product-account.test.ts` pins it.

---

## Types

### DerivedAccount

```ts
interface DerivedAccount {
  publicKey: Uint8Array;
  ss58Address: SS58String;
  h160Address: `0x${string}`;
  signer: PolkadotSigner;
}
```

### DerivedKeypairs

```ts
interface DerivedKeypairs {
  encryption: { publicKey: Uint8Array; secretKey: Uint8Array };
  signing: { publicKey: Uint8Array; secretKey: Uint8Array };
}
```

### SessionKeyInfo

```ts
interface SessionKeyInfo {
  mnemonic: string;
  account: DerivedAccount;
}
```
