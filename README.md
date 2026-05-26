# Product SDK

Monorepo for the `@parity/product-sdk` family of packages and tooling.

## Documentation

Full documentation is published at **[paritytech.github.io/product-sdk](https://paritytech.github.io/product-sdk/)**.

## product-sdk

TypeScript SDK for building products in the Polkadot ecosystem. Provides typed APIs for chain interactions, transaction signing, key management, and storage across Polkadot Desktop, Mobile, and browser environments.

| Package | Description |
|---------|-------------|
| `@parity/product-sdk` | Unified umbrella package — re-exports all modules |
| `@parity/product-sdk-chain-client` | Multi-chain Polkadot API client with typed access to Asset Hub, Bulletin, and other chains |
| `@parity/product-sdk-tx` | Transaction submission, lifecycle watching, and dev signers |
| `@parity/product-sdk-signer` | Multi-provider signer manager — Host API and dev accounts |
| `@parity/product-sdk-contracts` | Typed contract interactions on Polkadot Asset Hub |
| `@parity/product-sdk-cloud-storage` | Upload and retrieve data via Cloud Storage (currently backed by the Polkadot Bulletin Chain) |
| `@parity/product-sdk-statement-store` | Publish/subscribe client for the Polkadot Statement Store |
| `@parity/product-sdk-keys` | Hierarchical key derivation, session keys, and sr25519 product-account derivation |
| `@parity/product-sdk-local-storage` | Key-value local storage with automatic host/browser backend detection |
| `@parity/product-sdk-host` | Host container detection and storage access for Desktop/Mobile |
| `@parity/product-sdk-address` | SS58/H160 address encoding, validation, and conversion |
| `@parity/product-sdk-crypto` | Cryptographic primitives — encryption, key derivation, NaCl |
| `@parity/product-sdk-descriptors` | PAPI-generated chain descriptors for Polkadot ecosystem |
| `@parity/product-sdk-logger` | Structured, namespace-filtered logging |
| `@parity/product-sdk-utils` | Encoding utilities and token formatting |

See [product-sdk/README.md](./product-sdk/README.md) for installation, development, and E2E testing.

## Claude Code Plugin

This repo doubles as a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin marketplace. The plugin ships skills that teach Claude Code how to use the `@parity/product-sdk` packages — chain connections, transactions, contracts, cloud storage, statement store, utilities, and end-to-end app scaffolding.

### Install

```
/plugin marketplace add paritytech/product-sdk
/plugin install product-sdk@paritytech
/reload-plugins
```

The `/reload-plugins` step (or restarting Claude Code) is required to load the skills into your current session.

### Verify

```bash
claude plugin list                    # should show product-sdk@paritytech enabled
claude plugin details product-sdk     # shows all 8 skills + projected token cost
```

Or open a new Claude Code session and ask "build me a Polkadot app" — the `product-sdk:product-sdk-app-builder` skill should fire automatically.

### Skills included

| Skill | Use when |
|-------|----------|
| `product-sdk-app-builder` | Scaffolding a new Polkadot app or dApp end-to-end |
| `product-sdk-chain-connection` | Connecting to a chain, querying state, choosing preset vs BYOD descriptors |
| `product-sdk-transactions` | Submitting transactions, managing signers, key derivation |
| `product-sdk-contracts` | Smart contract calls on Asset Hub (PolkaVM/Solidity) |
| `product-sdk-cloud-storage` | CID-based upload/retrieve via Cloud Storage |
| `product-sdk-statement-store` | Publish/subscribe on the Polkadot Statement Store |
| `product-sdk-utilities` | Addresses, crypto, encoding, token formatting, logging |
| `migrating-to-product-sdk` | Porting an existing codebase from legacy stacks |

Skills live under [`product-sdk/skills/`](./product-sdk/skills/) and are auto-discovered by Claude Code at install time.
