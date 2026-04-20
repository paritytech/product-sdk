# Product SDK

This repository contains `@parity/product-sdk` — a unified library for building products on the Polkadot ecosystem. It is organised as a pnpm monorepo of small, focused packages plus an umbrella `@parity/product-sdk` package that re-exports the most common APIs.

## Overview

The Product SDK reduces code duplication across Parity's product portfolio by providing:

- **Chain Access** — TruAPI provider for container mode, PAPI integration (in progress).
- **Wallet** — Unified wallet connection for container mode (Host API accounts) and standalone mode (browser extensions).
- **Storage** — Key-value storage with automatic host/browser backend detection.
- **Bulletin** — Decentralized file storage via Bulletin Chain (upload, fetch, CID computation).
- **Crypto** — Symmetric encryption, hashing, key derivation (Noble-based).
- **Address** — SS58 / H160 / bytes32 conversion and validation utilities.
- **React Bindings** — Hooks and providers for React apps.

## Repository Structure

```
product-sdk/                       # repo root (paritytech/product-sdk)
├── README.md                      # this file
├── .gitmodules                    # consumer repos as submodules
├── repos/                         # consumer repos (git submodules, empty until initialised)
│   ├── bulletin-deploy/
│   ├── host-playground/
│   ├── host-sdk/
│   ├── ja3x/
│   ├── linktr33/
│   ├── mark3t/
│   ├── polkadot-web/
│   ├── product-engineering/
│   ├── r3lay/
│   ├── s3al/
│   ├── sh33ts/
│   ├── sourc3s/
│   ├── t3ams/
│   ├── t3rminal/
│   ├── triangle-js-sdks/
│   ├── truapi-explorer/
│   └── w3s-conference-app/
│
└── product-sdk/                   # pnpm monorepo (@parity/product-sdk-monorepo, private)
    ├── package.json
    ├── pnpm-workspace.yaml         # packages: ['packages/*']
    └── packages/
        ├── sdk/                    # @parity/product-sdk            (umbrella — what consumers import)
        ├── address/                # @parity/product-sdk-address
        ├── bulletin/               # @parity/product-sdk-bulletin
        ├── chain-client/           # @parity/product-sdk-chain-client
        ├── crypto/                 # @parity/product-sdk-crypto
        ├── host/                   # @parity/product-sdk-host
        ├── keys/                   # @parity/product-sdk-keys
        ├── logger/                 # @parity/product-sdk-logger
        ├── signer/                 # @parity/product-sdk-signer
        ├── storage/                # @parity/product-sdk-storage
        ├── tx/                     # @parity/product-sdk-tx
        └── utils/                  # @parity/product-sdk-utils
```

> **Note on the nested `product-sdk/product-sdk/` folder.** The inner directory is the pnpm monorepo; the outer directory is the git repo root (which also hosts the `repos/` submodules and this README). All pnpm commands run from the inner directory.

## Packages

The umbrella package `@parity/product-sdk` is **not** a thin re-exporter. It has its own source (under `packages/sdk/src/{core,chain,wallet,storage,bulletin,…}`) that internally depends on the sub-packages via `workspace:*`, but it only exposes a small surface: `createApp`, `configure`, `createLogger`, `chains`, plus React bindings at the `./react` subpath. To use anything else — crypto primitives, address helpers, the Bulletin client directly, the chain-client, etc. — import from the specific sub-package.

| Package | Purpose |
|---------|---------|
| `@parity/product-sdk` | Umbrella — exports `createApp`, `configure`, `createLogger`, `chains`, plus React bindings via `./react`. Small surface; import sub-packages for everything else. |
| `@parity/product-sdk-address` | SS58 / H160 encoding, validation, conversion. |
| `@parity/product-sdk-bulletin` | Bulletin Chain client (upload, fetch, CID computation). |
| `@parity/product-sdk-chain-client` | Multi-chain Polkadot API client with typed access (Asset Hub, Bulletin, etc.). |
| `@parity/product-sdk-crypto` | Symmetric encryption, key derivation, NaCl primitives. |
| `@parity/product-sdk-host` | Container detection (`isInsideContainer`), host-provided storage/provider/statement store. |
| `@parity/product-sdk-keys` | Hierarchical key derivation and session key management. |
| `@parity/product-sdk-logger` | Structured, namespace-filtered logging for the SDK ecosystem. |
| `@parity/product-sdk-signer` | Multi-provider signer manager (Host API, extensions, dev accounts). |
| `@parity/product-sdk-storage` | Key-value storage abstraction with automatic backend detection. |
| `@parity/product-sdk-tx` | Transaction submission, lifecycle watching, dev signers. |
| `@parity/product-sdk-utils` | Encoding utilities and token formatting. |

## Quick Start

### Install and build

From the inner monorepo:

```bash
cd product-sdk
pnpm install
pnpm build          # runs `pnpm -r build` — tsup builds every package
```

### Basic usage

```typescript
import { createApp } from '@parity/product-sdk';

const app = await createApp({
  name: 'my-app',
  logLevel: 'info',
});

// Connect wallet (container accounts in container mode; browser extensions in standalone mode)
const { accounts } = await app.wallet.connect();

// Key-value storage (host-backed in container, browser-backed otherwise)
await app.storage.set('theme', 'dark');
const theme = await app.storage.get('theme');

// Bulletin Chain
const cid = await app.bulletin.upload(file);
const data = await app.bulletin.fetch(cid);
```

> ⚠️ **`app.chain.getClient()` is currently unimplemented** (throws `"Chain client for <id> not yet implemented. PAPI integration requires additional setup."`). For chain access right now, use `@parity/product-sdk-chain-client` directly.

### Container vs Standalone Detection

```typescript
import { isInsideContainer, isInsideContainerSync } from '@parity/product-sdk-host';

const inContainer = await isInsideContainer(); // async, awaits host handshake
const quickCheck = isInsideContainerSync();    // synchronous best-effort check
```

`createApp()` internally performs this check and wires the storage/wallet backends accordingly. See the table below.

| Mode | Detected when… | Storage backend | Wallet accounts | Signer |
|------|----------------|-----------------|------------------|--------|
| **Container** | Running inside a Polkadot-web host (dot.li or local) | Host-provided localStorage via TruAPI | Host accounts via TruAPI | Host API signer |
| **Standalone** | Direct browser access | Browser `localStorage` | Browser wallet extensions | Extension signer |

### React usage

```tsx
import { ProductSDKProvider, useWallet, useStorage } from '@parity/product-sdk/react';

function App() {
  return (
    <ProductSDKProvider name="my-app">
      <MyApp />
    </ProductSDKProvider>
  );
}

function MyApp() {
  const { accounts, connect } = useWallet();
  const [theme, setTheme] = useStorage('theme', 'light');
  // ...
}
```

## Local Development

### Linking the SDK into a consumer repo

From the SDK umbrella package:

```bash
cd product-sdk/packages/sdk
pnpm link --global
```

From the consumer repo:

```bash
pnpm link --global @parity/product-sdk
```

Rebuild the SDK (`pnpm build` at the monorepo root, or `pnpm build` inside a single package) whenever you change its source — `pnpm link` does **not** trigger rebuilds.

> If the consumer also imports any of the sub-packages (e.g. `@parity/product-sdk-crypto`), `pnpm link --global` each of those from its own package folder as well. Linking only the umbrella does not transitively expose sub-packages to the consumer unless the umbrella re-exports them.

### Building a single package

```bash
cd product-sdk/packages/<pkg-name>
pnpm build
```

Each package uses `tsup` for bundling and outputs to `dist/`. Consumers resolve against `dist/`, so a missing `dist/` folder will cause imports to fail after linking.

## Working with Submodules (consumer repos)

The `repos/` folder contains consumer repos as git submodules. They are **not** initialised by default.

```bash
# Clone the SDK with all consumer repos
git clone --recurse-submodules git@github.com:paritytech/product-sdk.git

# Or initialise after a plain clone
git submodule update --init --recursive

# Initialise just one
git submodule update --init repos/mark3t

# Update all submodules to the latest commit on their tracked branch
git submodule update --remote --merge
```

> **Do the consumer repos need to live under `repos/`?** No. The submodule layout is a convenience for SDK maintainers who want to regression-test against many consumers at once. For a single-consumer migration or day-to-day consumer work, a standalone checkout of the consumer repo is simpler — `pnpm link --global` works from any location.

## Architecture notes

### Relationship to `@novasamatech/product-sdk`

The current SDK has its own `@parity/product-sdk-host` package that provides container detection, host-provided storage, and Host API access. Internally, some packages still delegate to `@novasamatech/product-sdk` for the low-level sandbox transport and spektr-wallet handshake, but those APIs are **not re-exported** through the public surface. Consumers should depend on the `@parity/*` packages, not reach through to the novasamatech APIs.

### Workspace resolution

The monorepo's `pnpm-workspace.yaml` lists `packages/*` only. `repos/*` is **not** part of the workspace. Adding it would pull all consumer `node_modules` into a shared lockfile with significant side effects; it is deliberately kept out of scope.

### Build tooling

- **Bundler:** `tsup` per package. Most packages use a `tsup.config.ts`; `@parity/product-sdk-utils` invokes `tsup` inline via its build script.
- **Language:** TypeScript ≥ 5.7, Node ≥ 20, pnpm ≥ 9.
- **Tests:** `vitest` per package.
- **Version:** all packages are currently `0.0.1` except `@parity/product-sdk-utils` (`0.1.0`). The public API should be treated as unstable.

### Current build state

A fresh clone will have some packages pre-built and others not. Run `pnpm build` at the monorepo root (`product-sdk/product-sdk`) to build all packages. Consumers cannot `pnpm link` into a package that has no `dist/` yet.

## License

Apache-2.0.
