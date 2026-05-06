# @parity/product-sdk-descriptors

PAPI-generated chain descriptors for the Polkadot ecosystem. These provide fully typed APIs for interacting with specific chains.

## Supported Chains

| Chain | Import Path | Network |
|-------|-------------|---------|
| Polkadot Asset Hub | `@parity/product-sdk-descriptors/polkadot-asset-hub` | Production |
| Kusama Asset Hub | `@parity/product-sdk-descriptors/kusama-asset-hub` | Production |
| Paseo Asset Hub | `@parity/product-sdk-descriptors/paseo-asset-hub` | Testnet |
| Bulletin | `@parity/product-sdk-descriptors/bulletin` | Testnet |
| Individuality | `@parity/product-sdk-descriptors/individuality` | Testnet |

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
