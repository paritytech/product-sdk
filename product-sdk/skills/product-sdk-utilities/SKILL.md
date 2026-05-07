---
name: product-sdk-utilities
description: >
  Use when working with Polkadot address encoding, SS58, H160, EVM address conversion,
  cryptographic encryption (AES, ChaCha, NaCl, HKDF), byte encoding/decoding, token
  formatting (planck), key-value storage, or structured logging in @parity/product-sdk packages.
  Covers address, crypto, utils, storage, and logger utilities.
---

# Product SDK Utility Packages

Five leaf packages provide foundational utilities. All are pure TypeScript and framework-agnostic.

## Decision Guide

| Need | Package | Import |
|------|---------|--------|
| SS58/H160 address encoding, validation, conversion | `address` | `@parity/product-sdk-address` |
| Encryption (AES-GCM, ChaCha20), key derivation (HKDF), NaCl | `crypto` | `@parity/product-sdk-crypto` |
| Byte encoding, hashing, token formatting (planck) | `utils` | `@parity/product-sdk-utils` |
| Persistent key-value storage | `storage` | `@parity/product-sdk-local-storage` |
| Structured logging | `logger` | `@parity/product-sdk-logger` |

## Quick Start: Address

```ts
import {
  isValidSs58,
  ss58Decode,
  ss58Encode,
  normalizeSs58,
  ss58ToH160,
  h160ToSs58,
  truncateAddress,
} from "@parity/product-sdk-address";

isValidSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"); // true
const { publicKey, prefix } = ss58Decode("5GrwvaEF...");
const polkadotAddr = normalizeSs58("5GrwvaEF...", 0);
const evmAddr = ss58ToH160("5GrwvaEF...");
truncateAddress("5GrwvaEF..."); // "5Grwva...utQY"
```

## Quick Start: Crypto

```ts
import {
  xchachaEncrypt,
  xchachaDecrypt,
  deriveKey,
  randomBytes,
  sealedBoxEncrypt,
  sealedBoxDecrypt,
} from "@parity/product-sdk-crypto";

const key = randomBytes(32);
const { ciphertext, nonce } = xchachaEncrypt(data, key);
const plaintext = xchachaDecrypt(ciphertext, key, nonce);
const encKey = deriveKey(masterSecret, "myapp-v1", "encryption");
```

## Quick Start: Utils

```ts
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@parity/product-sdk-utils";
import { blake2b256, sha256, keccak256 } from "@parity/product-sdk-utils";
import { formatPlanck, parseToPlanck, formatBalance } from "@parity/product-sdk-utils";

const hex = bytesToHex(new Uint8Array([0xab, 0xcd]));
const hash = blake2b256(new TextEncoder().encode("hello"));
formatPlanck(10_000_000_000n);   // "1.0" (DOT)
parseToPlanck("1.5");             // 15_000_000_000n
formatBalance(10_000_000_000_000n, { symbol: "DOT" }); // "1,000 DOT"
```

## Quick Start: Storage

```ts
import { createLocalKvStore } from "@parity/product-sdk-local-storage";

const store = await createLocalKvStore({ prefix: "myapp" });
await store.set("theme", "dark");
const theme = await store.get("theme");
await store.setJSON("prefs", { lang: "en" });
const prefs = await store.getJSON<{ lang: string }>("prefs");
```

## Quick Start: Logger

```ts
import { createLogger, configure } from "@parity/product-sdk-logger";

const log = createLogger("my-feature");
log.error("Connection failed", { url, status });
log.info("Connected");
log.debug("Payload received", payload);

configure({ level: "debug", namespaces: ["my-feature"] });
```

## Common Mistakes

### Address

- **Comparing SS58 addresses at different prefixes** - Use `normalizeSs58()` first
- **Assuming `ss58ToH160` is reversible for native accounts** - Keccak256 derivation is one-way

### Crypto

- **Using `chachaEncrypt` for high-volume random nonces** - Use `xchachaEncrypt` instead
- **Forgetting 32-byte key requirement** - Use `deriveKey()` to derive proper keys

### Utils

- **Passing `0x`-prefixed string to `hexToBytes`** - Strip it first: `hex.slice(2)`
- **Wrong decimals for chain** - DOT=10, KSM=12, many parachains=18

### Storage

- **Calling `createLocalKvStore` synchronously** - It returns a Promise, always `await`

### Logger

- **Assuming `configure()` only affects future loggers** - It affects all existing instances

## Reference Files

- [address-api.md](references/address-api.md) - SS58, H160, display utilities
- [crypto-api.md](references/crypto-api.md) - AES-GCM, ChaCha20, HKDF, NaCl
- [utils-api.md](references/utils-api.md) - Encoding, hashing, token formatting
- [storage-api.md](references/storage-api.md) - LocalKvStore creation and types
- [logger-api.md](references/logger-api.md) - configure, createLogger, types
