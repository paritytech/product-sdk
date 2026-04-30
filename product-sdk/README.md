# Product SDK

TypeScript SDK for building products in the Polkadot ecosystem. Provides typed APIs for chain interactions, transaction signing, key management, and storage across Polkadot Desktop, Mobile, and browser environments.

## Packages

| Package | Description |
|---------|-------------|
| `@parity/product-sdk` | Unified umbrella package — re-exports all modules |
| `@parity/product-sdk-chain-client` | Multi-chain Polkadot API client with typed access to Asset Hub, Bulletin, and other chains |
| `@parity/product-sdk-tx` | Transaction submission, lifecycle watching, and dev signers |
| `@parity/product-sdk-signer` | Multi-provider signer manager — Host API, browser extensions, and dev accounts |
| `@parity/product-sdk-contracts` | Typed contract interactions on Polkadot Asset Hub |
| `@parity/product-sdk-bulletin` | Upload and retrieve data on the Polkadot Bulletin Chain |
| `@parity/product-sdk-statement-store` | Publish/subscribe client for the Polkadot Statement Store |
| `@parity/product-sdk-keys` | Hierarchical key derivation and session key management |
| `@parity/product-sdk-storage` | Key-value storage with automatic host/browser backend detection |
| `@parity/product-sdk-host` | Host container detection and storage access for Desktop/Mobile |
| `@parity/product-sdk-address` | SS58/H160 address encoding, validation, and conversion |
| `@parity/product-sdk-crypto` | Cryptographic primitives — encryption, key derivation, NaCl |
| `@parity/product-sdk-descriptors` | PAPI-generated chain descriptors for Polkadot ecosystem |
| `@parity/product-sdk-logger` | Structured, namespace-filtered logging |
| `@parity/product-sdk-utils` | Encoding utilities and token formatting |

## Installation

```bash
# Install the umbrella package
pnpm add @parity/product-sdk

# Or install individual packages
pnpm add @parity/product-sdk-chain-client @parity/product-sdk-tx
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run unit tests
pnpm test

# Lint and format
pnpm check
```

## E2E Testing

The `examples/` directory contains 9 demo apps that exercise the SDK packages via Playwright:

| Demo | Tests |
|------|-------|
| `host-demo` | Container detection, host localStorage |
| `storage-demo` | KvStore operations, prefix namespacing |
| `keys-demo` | Key derivation, session key lifecycle |
| `chain-client-demo` | Preset connections, BYOD, lifecycle |
| `signer-demo` | Account discovery, signing, permissions |
| `tx-demo` | Transaction submission, batching, finalization |
| `contracts-demo` | Contract queries and submissions |
| `bulletin-demo` | CID computation, upload, query |
| `statement-store-demo` | Publish/subscribe, channels |

```bash
# Install Playwright browsers (first time)
pnpm --filter "@parity/product-sdk-host-demo" exec playwright install --with-deps chromium

# Run all E2E tests
pnpm test:e2e

# Run a specific demo's tests
pnpm --filter "@parity/product-sdk-signer-demo" test:e2e

# Run with UI for debugging
pnpm --filter "@parity/product-sdk-signer-demo" test:e2e:ui
```

## Bundle Size

Every PR runs a bundle-size benchmark across all SDK packages and posts a diff comment. See [BUNDLE_SIZE.md](./BUNDLE_SIZE.md) for what's measured and how to debug regressions.

```bash
pnpm bench           # measure current sizes locally
pnpm bench:compare   # compare against a saved snapshot (CI uses this)
```

## License

Apache-2.0
