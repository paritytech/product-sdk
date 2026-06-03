# Project Templates

## Minimal Query App

Read chain state without writing transactions.

### package.json

```json
{
  "name": "my-polkadot-query-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@parity/product-sdk-chain-client": "latest",
    "polkadot-api": "^2.0.2"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### src/index.ts

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";

async function main() {
    const client = await getChainAPI("paseo");

    const account = await client.assetHub.query.System.Account.getValue(
        "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
    );

    console.log("Free balance:", account.data.free);

    client.destroy();
}

main().catch(console.error);
```

---

## Transaction App (with dev signer)

Submit transactions on testnets using built-in dev accounts.

### package.json

```json
{
  "name": "my-polkadot-tx-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@parity/product-sdk-chain-client": "latest",
    "@parity/product-sdk-tx": "latest",
    "polkadot-api": "^2.0.2"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### src/index.ts

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { createDevSigner, submitAndWatch } from "@parity/product-sdk-tx";

async function main() {
    const client = await getChainAPI("paseo");
    const alice = createDevSigner("Alice");

    const tx = client.assetHub.tx.System.remark({
        remark: "Hello from Product SDK!",
    });

    const result = await submitAndWatch(tx, alice.signer, {
        waitFor: "finalized",
        onStatus: (status) => console.log("Status:", status),
    });

    console.log("Block hash:", result.blockHash);

    client.destroy();
}

main().catch(console.error);
```

---

## dApp with Wallet Integration

Full user-facing app with wallet connection.

### package.json

```json
{
  "name": "my-polkadot-dapp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@parity/product-sdk-chain-client": "latest",
    "@parity/product-sdk-tx": "latest",
    "@parity/product-sdk-signer": "latest",
    "@parity/product-sdk-address": "latest",
    "@parity/product-sdk-utils": "latest",
    "polkadot-api": "^2.0.2"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### src/index.ts

```typescript
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { SignerManager } from "@parity/product-sdk-signer";
import { submitAndWatch } from "@parity/product-sdk-tx";
import { truncateAddress } from "@parity/product-sdk-address";
import { formatBalance } from "@parity/product-sdk-utils";

async function main() {
    const client = await getChainAPI("paseo");

    // Connect to host-provided accounts
    const signerManager = new SignerManager();
    await signerManager.connect();

    const accounts = signerManager.getAccounts();
    console.log("Available accounts:");
    for (const account of accounts) {
        console.log(`  ${truncateAddress(account.address)}`);
    }

    // Use first account
    const signer = signerManager.getSigner(accounts[0].address);

    // Query balance
    const accountData = await client.assetHub.query.System.Account.getValue(
        accounts[0].address
    );
    console.log("Balance:", formatBalance(accountData.data.free, { symbol: "DOT" }));

    // Submit transaction
    const tx = client.assetHub.tx.System.remark({
        remark: "Hello from dApp!",
    });

    await submitAndWatch(tx, signer, { waitFor: "best-block" });

    signerManager.destroy();
    client.destroy();
}

main().catch(console.error);
```

---

## Contract dApp

Interact with PolkaVM/Solidity smart contracts on Asset Hub.

### package.json

```json
{
  "name": "my-contract-dapp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@parity/product-sdk-chain-client": "latest",
    "@parity/product-sdk-contracts": "latest",
    "@parity/product-sdk-signer": "latest",
    "polkadot-api": "^2.0.2"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### src/index.ts

```typescript
import { createChainClient } from "@parity/product-sdk-chain-client";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { createContractFromClient } from "@parity/product-sdk-contracts";
import { SignerManager } from "@parity/product-sdk-signer";

const counterAbi = [
    {
        type: "function",
        name: "getCount",
        inputs: [],
        outputs: [{ name: "", type: "uint32" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "increment",
        inputs: [],
        outputs: [],
        stateMutability: "nonpayable",
    },
];

async function main() {
    const client = await createChainClient({
        chains: { assetHub: paseo_asset_hub },
    });

    const signerManager = new SignerManager();
    await signerManager.connect();

    const counter = createContractFromClient(
        client.raw.assetHub,
        paseo_asset_hub,
        "0xYourContractAddress...",
        counterAbi,
        { signerManager }
    );

    // Read state
    const { value } = await counter.getCount.query();
    console.log("Current count:", value);

    // Write state
    await counter.increment.tx();
    console.log("Incremented!");

    signerManager.destroy();
    client.destroy();
}

main().catch(console.error);
```

---

## Cloud Storage App

Upload and retrieve data from Cloud Storage.

### package.json

```json
{
  "name": "my-cloud-storage-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@parity/product-sdk-chain-client": "latest",
    "@parity/product-sdk-cloud-storage": "latest",
    "@parity/product-sdk-tx": "latest",
    "polkadot-api": "^2.0.2"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### src/index.ts

```typescript
import { CloudStorageClient } from "@parity/product-sdk-cloud-storage";

async function main() {
    const bulletin = await CloudStorageClient.create("paseo");

    // Upload data (must be Uint8Array)
    const data = new TextEncoder().encode(
        JSON.stringify({ title: "Hello Bulletin", timestamp: Date.now() })
    );

    const result = await bulletin.upload(data);
    console.log("Uploaded CID:", result.cid);

    // Fetch it back
    const content = await bulletin.fetchJson<{ title: string; timestamp: number }>(
        result.cid
    );
    console.log("Retrieved:", content.title);

    bulletin.destroy();
}

main().catch(console.error);
```

---

## Real-Time Messaging App

Pub/sub messaging with the Statement Store.

### package.json

```json
{
  "name": "my-messaging-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@parity/product-sdk-statement-store": "latest",
    "@parity/product-sdk-keys": "latest",
    "polkadot-api": "^2.0.2"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

### src/index.ts

```typescript
import { StatementStoreClient } from "@parity/product-sdk-statement-store";
import { seedToAccount } from "@parity/product-sdk-keys";

async function main() {
    // Create a local signer from a test mnemonic
    const account = seedToAccount(
        "bottom drive obey lake curtain smoke basket hold race lonely fit walk"
    );

    const client = new StatementStoreClient({
        appName: "my-messaging-app",
        endpoint: "wss://paseo-bulletin-next-rpc.polkadot.io",
    });

    await client.connect({
        mode: "local",
        signer: {
            publicKey: account.publicKey,
            sign: async (msg) => {
                // Use account.signer for signing
                return account.signer.sign(msg);
            },
        },
    });

    // Subscribe to messages
    const sub = client.subscribe<{ type: string; message: string }>((statement) => {
        console.log("Received:", statement.data.message);
    });

    // Publish a message
    await client.publish(
        { type: "chat", message: "Hello, world!" },
        { channel: "general" }
    );

    // Keep running for 30 seconds
    await new Promise((resolve) => setTimeout(resolve, 30_000));

    sub.unsubscribe();
    client.destroy();
}

main().catch(console.error);
```

---

## tsconfig.json (Common)

Use this configuration for all templates:

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
