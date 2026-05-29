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

Canonical sr25519 product-account public-key derivation. Mirrors the algorithm in polkadot-desktop (`productAccountService.deriveProductPublicKey`) and polkadot-app-android-v2 (`ProductAccountDerivationUseCase`), so an external client (CLI, web host) can compute the same derived address the mobile wallet derives privately, without ever seeing the secret key.

```ts
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";

function deriveProductAccountPublicKey(
  parentPublicKey: Uint8Array,
  productId: string,
  derivationIndex: number,
): Uint8Array
```

Applies sr25519 soft derivation (`HDKD.publicSoft`) left-to-right over the junctions `["product", productId, String(derivationIndex)]`. Returns the 32-byte derived public key.

### productId constraint (cross-platform parity)

`productId` MUST contain at least one non-hex character OR be of odd length when serialized as a string. polkadot-app-android-v2's `SubstrateJunctionDecoder` tries to interpret a junction as hex BEFORE falling through to SCALE-string encoding; polkadot-desktop and this implementation skip that hex branch. For productIds that happen to be even-length all-hex strings (e.g. `"deadbeef"`), Android would derive a different public key. dotNS names like `"playground.dot"` always contain `.` and never trip the hex branch.

---

## createChainCode

Lower-level helper for building custom junction paths. Encodes a junction the way Substrate does:

```ts
import { createChainCode } from "@parity/product-sdk-keys";

function createChainCode(code: string): Uint8Array  // 32-byte chain code
```

- `code` matching `^\d+$`: SCALE `u64` of `BigInt(code)`, zero-padded to 32 bytes.
- Other strings: SCALE `str` (compact-length + UTF-8), zero-padded to 32 bytes.
- If the encoded form exceeds 32 bytes: `blake2b256(encoded)`.

Most consumers should use `deriveProductAccountPublicKey` instead; `createChainCode` is exported for callers that need to derive against non-`["product", ...]` junction paths.

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
