---
name: product-sdk-app-builder
description: >
  End-to-end scaffolding and implementation of Polkadot applications using @parity/product-sdk packages.
  Use when: creating a new Polkadot project, building a dApp, scaffolding chain interactions,
  choosing which @parity/product-sdk packages to install, or when a user says "build me a Polkadot app".
  Handles both developer-guided and fully autonomous (non-developer) workflows.
---

# Product SDK App Builder

Orchestrator skill for building applications with the `@parity/product-sdk` package ecosystem.

## Quick Start

### Preset Path (zero-config for known environments)

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

const client = await getChainAPI("paseo");
const balance = await client.assetHub.query.System.Account.getValue("5GrwvaEF...");
client.destroy();
```

### BYOD Path (Bring Your Own Descriptors)

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub },
});
const balance = await client.assetHub.query.System.Account.getValue("5GrwvaEF...");
client.destroy();
```

## Workflow

### 1. Understand Requirements

Determine what the app needs:
- **Read chain state** (balances, storage, block info)
- **Submit transactions** (transfers, remarks, contract calls)
- **Store data** in Cloud Storage
- **Real-time messaging** via Statement Store
- **Address utilities** (SS58, H160 conversion)
- **Encryption** (AES, ChaCha20, NaCl)
- **Key management** (derivation, session keys)

### 2. Select Packages

Use the decision tree in [references/package-selector.md](references/package-selector.md).

**Every app needs:**
```
@parity/product-sdk-chain-client    # Connect to chains
@parity/product-sdk-descriptors     # Chain type definitions (peer dep of chain-client)
polkadot-api                        # Core runtime (peer dep of descriptors)
```

**Add based on features:**

| Feature | Package | Skill |
|---------|---------|-------|
| Smart contracts (PolkaVM/Solidity) | `@parity/product-sdk-contracts` | product-sdk-contracts |
| Submit transactions | `@parity/product-sdk-tx` | product-sdk-transactions |
| Wallet connection (Talisman, Polkadot.js, Host API) | `@parity/product-sdk-signer` | product-sdk-transactions |
| Key derivation | `@parity/product-sdk-keys` | product-sdk-transactions |
| Decentralized storage | `@parity/product-sdk-cloud-storage` | product-sdk-cloud-storage |
| Pub/sub messaging | `@parity/product-sdk-statement-store` | product-sdk-statement-store |
| Address encoding | `@parity/product-sdk-address` | product-sdk-utilities |
| Encryption | `@parity/product-sdk-crypto` | product-sdk-utilities |
| KV storage | `@parity/product-sdk-local-storage` | product-sdk-utilities |
| Logging | `@parity/product-sdk-logger` | product-sdk-utilities |

### 3. Scaffold Project

Use templates in [references/project-templates.md](references/project-templates.md).

```bash
mkdir my-polkadot-app && cd my-polkadot-app
npm init -y
```

**package.json** essentials:
```json
{
  "type": "module",
  "dependencies": {
    "@parity/product-sdk-chain-client": "latest",
    "polkadot-api": "^2.0.2"
  }
}
```

**tsconfig.json** essentials:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

Install:
```bash
npm install
```

### 4. Implement

Invoke the relevant domain skill(s) based on the selected packages:
- **product-sdk-chain-connection** — for connecting and querying chains
- **product-sdk-contracts** — for smart contracts (ContractManager, createContract, ContractRuntime, codegen)
- **product-sdk-transactions** — for submitting transactions, signing, keys
- **product-sdk-cloud-storage** — for Cloud Storage
- **product-sdk-statement-store** — for pub/sub messaging
- **product-sdk-utilities** — for address, crypto, storage, logger

### 5. Build and Verify

```bash
npx tsc            # Compile TypeScript
node dist/index.js # Run the app
```

## Chain Client: BYOD vs Preset

`@parity/product-sdk-chain-client` offers two paths for connecting to chains:

| | `getChainAPI` (Preset) | `createChainClient` (BYOD) |
|---|---|---|
| **When** | Known environments (paseo, polkadot, kusama) | Custom chains or a subset of chains |
| **Descriptors** | Built-in, lazy-loaded | You import and provide them |
| **Chains** | Always assetHub + bulletin + individuality | Any combination you choose |
| **Bundle size** | Slightly larger (all 3 chains loaded) | Minimal (only what you import) |

**Use `getChainAPI`** when you want zero-config connection to a standard environment.

**Use `createChainClient`** when you need:
- Only one chain (e.g., just Asset Hub for contracts)
- Chains not in the preset list
- Minimal bundle size

Both return the same `ChainClient` type with `.raw` access for advanced use (e.g., `createContractRuntime`).

## Environments and Chains

See [references/chains.md](references/chains.md) for full details.

> **WARNING:** Only the `"paseo"` environment is currently available. Using `"polkadot"` or `"kusama"` will throw an error.

| Environment | Asset Hub | Bulletin | Individuality |
|-------------|-----------|----------|---------------|
| **paseo** (testnet) | Yes | Yes | Yes |
| polkadot (mainnet) | Planned | Planned | Planned |
| kusama (canary) | Planned | Planned | Planned |

## Common Mistakes

1. **Missing `polkadot-api`** — It's a peer dependency of `@parity/product-sdk-descriptors`. Always install it.
2. **Barrel import of descriptors** — Use `@parity/product-sdk-descriptors/paseo-bulletin`, NOT `@parity/product-sdk-descriptors`.
3. **Using unavailable environments** — Only `"paseo"` works. `"polkadot"` and `"kusama"` throw.
4. **Forgetting `await`** — `getChainAPI()` and `createChainClient()` return a Promise. Always `await` it.
5. **Not cleaning up** — Call `client.destroy()` or `destroyAll()` when done to close WebSocket connections.
6. **Using `api.contracts`** — There is no `.contracts` property on chain clients. Create ContractRuntime yourself: `createContractRuntime(client.raw.assetHub, { atBest: true })`, or use `ContractManager.fromClient()` for convenience.
7. **Dev signers in production** — `createDevSigner("Alice")` is testnet-only. Use `SignerManager` for production.
8. **Wrong signer type** — `PolkadotSigner` (tx), `StatementSignerWithKey` (statement-store), and `SignerManager` (wallet UI) are distinct.

## Non-Developer Tier

When building autonomously for a non-technical user:

1. Ask what the app should do (in plain language)
2. Map requirements to packages using the selector
3. Scaffold the project with all dependencies
4. Implement all features using domain skills
5. Build and test before presenting the result
6. Include clear instructions for running the app

## Developer Tier

When assisting a developer:

1. Present the package selection rationale
2. Show the project scaffold and let them review
3. Implement features incrementally, explaining each step
4. Reference the domain skill docs for API details
5. Let the developer customize and extend

## Resources

- **Repository**: https://github.com/nicobao/product-sdk-docs
- **npm packages**: https://www.npmjs.com/org/parity
- **polkadot-api docs**: https://papi.how
