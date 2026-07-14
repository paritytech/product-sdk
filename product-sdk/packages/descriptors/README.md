# @parity/product-sdk-descriptors

PAPI-generated chain descriptors for the Polkadot ecosystem. These provide fully typed APIs for interacting with specific chains.

## Supported Chains

| Chain | Import Path | Network |
|-------|-------------|---------|
| Polkadot Asset Hub | `@parity/product-sdk-descriptors/polkadot-asset-hub` | Production |
| Kusama Asset Hub | `@parity/product-sdk-descriptors/kusama-asset-hub` | Production |
| Paseo Asset Hub | `@parity/product-sdk-descriptors/paseo-asset-hub` | Testnet |
| Paseo Bulletin | `@parity/product-sdk-descriptors/paseo-bulletin` | Testnet |
| Paseo Individuality | `@parity/product-sdk-descriptors/paseo-individuality` | Testnet |
| Summit Asset Hub | `@parity/product-sdk-descriptors/summit-asset-hub` | Summit |
| Summit Bulletin | `@parity/product-sdk-descriptors/summit-bulletin` | Summit |
| Summit Individuality | `@parity/product-sdk-descriptors/summit-individuality` | Summit |

## Usage

```typescript
import { polkadot_asset_hub } from "@parity/product-sdk-descriptors/polkadot-asset-hub";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

// Create a typed client for Polkadot Asset Hub
const client = createClient(
  getWsProvider("wss://polkadot-asset-hub-rpc.polkadot.io")
);

const api = client.getTypedApi(polkadot_asset_hub);

// Now you have full type safety for all chain operations
const balance = await api.query.System.Account.getValue(address);
```

## Regenerating Descriptors

To fetch the latest metadata from live chains and regenerate descriptors:

```bash
pnpm generate
```

To compile the generated TypeScript:

```bash
pnpm build
```

## Adding a New Chain

1. Create a new directory under `chains/`:
   ```bash
   mkdir -p chains/new-chain/.papi
   ```

2. Create the PAPI config file `chains/new-chain/.papi/polkadot-api.json`:
   ```json
   {
     "version": 0,
     "descriptorPath": "generated",
     "entries": {
       "new_chain": {
         "wsUrl": "wss://new-chain-rpc.example.com",
         "metadata": "../../.papi/metadata/new_chain.scale"
       }
     }
   }
   ```

3. Create `chains/new-chain/tsconfig.json` (copy from an existing chain)

4. Add the export to the main `package.json`:
   ```json
   "./new-chain": {
     "types": "./chains/new-chain/generated/new_chain.d.ts",
     "default": "./chains/new-chain/generated/new_chain.js"
   }
   ```

5. Run `pnpm generate` to fetch metadata and generate descriptors

## Detecting Drift

PAPI's bundled type bindings are a frozen snapshot at the moment `pnpm generate` last ran. When a chain runtime upgrades, the bundled descriptors go stale — PAPI then either errors with `Incompatible runtime entry RuntimeCall(...)` or silently mis-decodes a subscription so it never emits an event.

The [`product-sdk: Descriptors drift`](../../../.github/workflows/product-sdk-descriptors-drift.yml) workflow catches this before E2E does. It runs daily, connects to each chain's RPC via `papi update --skip-codegen`, and compares the live `codeHash` and `genesis` against what's pinned in `chains/*/.papi/polkadot-api.json`.

On drift it opens (or updates in place) a single tracking issue labeled `descriptors-drift`. On a fully-clean run it closes the issue.

### What to do when the auto-issue fires

1. `cd packages/descriptors`
2. `pnpm generate` — fetches fresh metadata from every chain RPC and rewrites `chains/*/.papi/polkadot-api.json` + the `.scale` metadata blobs
3. `pnpm build` — regenerates the TypeScript bindings under `chains/*/generated/dist/`
4. `git diff packages/descriptors/` — verify nothing else changed unexpectedly
5. `pnpm changeset` — add a `@parity/product-sdk-descriptors: patch` entry (or `minor` if the runtime added new pallets or changed decode shape)
6. Open a PR. Run `pnpm test:e2e` against the regenerated bindings before merging — drift sometimes hides a real consumer-side break (e.g. a pallet rename)

The workflow will close the tracking issue automatically on the next scheduled run once every chain is clean.
