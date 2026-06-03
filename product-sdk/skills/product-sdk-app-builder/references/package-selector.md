# Package Selector

Decision tree for choosing `@parity/product-sdk` packages based on application requirements.

## Decision Tree

```
START
│
├─ Need to connect to Polkadot chains?
│  YES → @parity/product-sdk-chain-client + polkadot-api (always required)
│  │
│  ├─ Want zero-config for a known environment (paseo/polkadot/kusama)?
│  │  YES → getChainAPI("paseo") — built-in descriptors
│  │
│  └─ Need custom chains or minimal bundle?
│     YES → createChainClient({ chains }) — bring your own descriptors
│
├─ Need to submit transactions?
│  YES → @parity/product-sdk-tx
│  │
│  ├─ Need wallet connection (Talisman, Polkadot.js, SubWallet, Host API)?
│  │  YES → @parity/product-sdk-signer (SignerManager handles multi-provider accounts)
│  │
│  ├─ Need testnet dev accounts only?
│  │  YES → @parity/product-sdk-tx (includes createDevSigner)
│  │
│  └─ Need key derivation or session keys?
│     YES → @parity/product-sdk-keys
│
├─ Need to interact with smart contracts (PolkaVM/Solidity on Asset Hub)?
│  YES → @parity/product-sdk-contracts
│  │
│  ├─ Have a cdm.json manifest?
│  │  YES → ContractManager (fully-typed handles via codegen)
│  │
│  └─ Just have an address + ABI?
│     YES → createContract (same ergonomics, no manifest)
│
├─ Need decentralized data storage (files, JSON, blobs)?
│  YES → @parity/product-sdk-cloud-storage
│
├─ Need real-time pub/sub messaging (ephemeral, ≤512 bytes)?
│  YES → @parity/product-sdk-statement-store
│
├─ Need address encoding/validation?
│  YES → @parity/product-sdk-address
│
├─ Need encryption/decryption?
│  YES → @parity/product-sdk-crypto
│
├─ Need byte encoding (hex, UTF-8) or token formatting (planck)?
│  YES → @parity/product-sdk-utils
│
├─ Need persistent key-value storage (browser/host)?
│  YES → @parity/product-sdk-local-storage
│
└─ Need structured logging?
   YES → @parity/product-sdk-logger
```

## Common App Patterns

### Query-Only App (read chain state)
```
@parity/product-sdk-chain-client
polkadot-api
```

### Transaction App (read + write)
```
@parity/product-sdk-chain-client
@parity/product-sdk-tx
polkadot-api
```

### dApp with Wallet (full user-facing app)
```
@parity/product-sdk-chain-client
@parity/product-sdk-tx
@parity/product-sdk-signer
@parity/product-sdk-address
@parity/product-sdk-utils
polkadot-api
```

### Contract dApp (interact with smart contracts)
```
@parity/product-sdk-chain-client
@parity/product-sdk-contracts
@parity/product-sdk-signer
polkadot-api
```

### Data Storage App (upload/download files)
```
@parity/product-sdk-chain-client
@parity/product-sdk-cloud-storage
@parity/product-sdk-tx
polkadot-api
```

### Real-Time Messaging App
```
@parity/product-sdk-statement-store
@parity/product-sdk-keys
polkadot-api
```

### Full-Featured App (everything)
```
@parity/product-sdk-chain-client
@parity/product-sdk-contracts
@parity/product-sdk-tx
@parity/product-sdk-signer
@parity/product-sdk-cloud-storage
@parity/product-sdk-statement-store
@parity/product-sdk-address
@parity/product-sdk-crypto
@parity/product-sdk-utils
@parity/product-sdk-keys
@parity/product-sdk-local-storage
@parity/product-sdk-logger
polkadot-api
```

## Package Dependency Graph

```
address ─────────────────────────── (leaf)
crypto ──────────────────────────── (leaf)
utils ───────────────────────────── (leaf, depends on logger)
logger ──────────────────────────── (leaf)
host ────────────────────────────── (leaf)
local-storage ← host, logger
keys ← address, crypto, utils, local-storage
tx ← keys, logger
signer ← address, keys, logger
chain-client ← descriptors, host  (provides .raw for ContractRuntime creation)
contracts ← tx, signer, keys, logger  (needs ContractRuntime from @parity/product-sdk-contracts)
cloud-storage ← chain-client, descriptors, host, logger, tx
statement-store ← host, logger, utils  (+ @novasamatech/sdk-statement, @polkadot-api/substrate-client)
```

Note: `contracts` no longer depends on `chain-client`. Create ContractRuntime yourself from `client.raw.<chain>` and pass it to `ContractManager` or `createContract`.

Transitive dependencies are handled automatically by npm/pnpm — install only the packages you directly use.
