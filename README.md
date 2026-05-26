# Product SDK Docs

Internal monorepo for SDK packages and tooling.

## product-sdk

TypeScript SDK for building products in the Polkadot ecosystem. Provides typed APIs for chain interactions, transaction signing, key management, and storage across Polkadot Desktop, Mobile, and browser environments.

See [product-sdk/README.md](./product-sdk/README.md) for details.

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
claude plugin list                     # should show product-sdk@paritytech enabled
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

## More tools coming soon
