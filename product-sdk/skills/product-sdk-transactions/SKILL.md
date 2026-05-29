---
name: product-sdk-transactions
description: >
  Submit transactions, connect wallets, manage signers, and handle keys in product-sdk.
  Use when: submitting transactions, integrating Host API signing (Polkadot Desktop/Mobile),
  managing multi-provider wallet accounts, deriving keys, or creating dev signers for testnet.
  Covers @parity/product-sdk-tx (submit/watch), @parity/product-sdk-signer (wallet connection, account
  management, multi-provider signing), and @parity/product-sdk-keys (key derivation, session keys).
---

# Product SDK Transactions, Signing, and Key Management

This skill covers three packages that work together for submitting on-chain transactions:

| Package | Import | Purpose |
|---------|--------|---------|
| tx | `@parity/product-sdk-tx` | Submit, watch, retry transactions |
| signer | `@parity/product-sdk-signer` | Manage signing accounts across providers |
| keys | `@parity/product-sdk-keys` | Derive keys, accounts, and session keys |

## Quick Start: Submit a Transaction in 10 Lines

```ts
import { createDevSigner, submitAndWatch } from "@parity/product-sdk-tx";
import type { TxStatus, TxResult } from "@parity/product-sdk-tx";

// 1. Get a signer (dev signer for testnet)
const alice = createDevSigner("Alice");

// 2. Build a transaction (from PAPI typed API)
// Note: `dest` is a MultiAddress enum — pass as { type: "Id", value: ss58Address }
const tx = api.tx.Balances.transfer_keep_alive({
  dest: { type: "Id", value: recipientAddress },
  value: 1_000_000_000_000n,
});

// 3. Submit and watch
const result = await submitAndWatch(tx, alice);
// result: { txHash, ok, block: { hash, number, index }, events, dispatchError? }
console.log(result.ok ? "Success" : "Failed", result.block.hash);
```

> **WARNING: Dev signers (`createDevSigner`) use well-known private keys. They are for local development and testnets ONLY. Never use in production.**

## Three Distinct Signer Types

> **WARNING: Three different signer-related types exist in this codebase. Do not confuse them.**

| Type | Package | What It Is |
|------|---------|------------|
| `PolkadotSigner` | `polkadot-api` | Low-level signer passed to `submitAndWatch()`. Signs extrinsics. |
| `SignerAccount` | `@parity/product-sdk-signer` | Account wrapper with address, publicKey, source, and `getSigner()` that returns a `PolkadotSigner`. |
| `SignerManager` | `@parity/product-sdk-signer` | Orchestrator that discovers accounts from multiple providers and manages selection state. |

How they connect:

```
SignerManager.connect() -> SignerAccount[] -> account.getSigner() -> PolkadotSigner -> submitAndWatch(tx, signer)
```

## Transaction Lifecycle

### 1. Build the Transaction

From a PAPI typed API:
```ts
const tx = api.tx.Balances.transfer_keep_alive({ dest, value });
```

From an Ink SDK contract (dry-run first):
```ts
import { extractTransaction } from "@parity/product-sdk-tx";

const dryRun = await contract.query("mint", { origin, data: { name, price } });
const tx = extractTransaction(dryRun); // Throws TxDryRunError on failure
```

### 2. Sign and Submit

```ts
import { submitAndWatch } from "@parity/product-sdk-tx";

// TxStatus = "signing" | "broadcasting" | "in-block" | "finalized" | "error"
const result = await submitAndWatch(tx, signer, {
  waitFor: "best-block",     // or "finalized" (slower but safer)
  timeoutMs: 300_000,        // 5 minutes default
  mortalityPeriod: 256,      // ~43 minutes on Polkadot
  onStatus: (status: TxStatus) => updateUI(status),
});
// result: TxResult { txHash, ok, block: { hash, number, index }, events, dispatchError? }
```

### 3. Batch Multiple Transactions

Submit multiple transactions as a single atomic batch — one signing prompt, one fee.

```ts
import { batchSubmitAndWatch } from "@parity/product-sdk-tx";

const tx1 = client.assetHub.tx.Balances.transfer_keep_alive({ dest: addr1, value: 1_000n });
const tx2 = client.assetHub.tx.Balances.transfer_keep_alive({ dest: addr2, value: 2_000n });
const tx3 = client.assetHub.tx.System.remark({ remark: Binary.fromText("hello") });

const result = await batchSubmitAndWatch([tx1, tx2, tx3], client.assetHub, signer, {
  onStatus: (status: TxStatus) => updateUI(status),
});
```

Three batch modes:

| Mode | Behavior |
|------|----------|
| `"batch_all"` (default) | Atomic. Reverts all calls if any single call fails. |
| `"batch"` | Best-effort. Stops at first failure but earlier successful calls are not reverted. |
| `"force_batch"` | Like `batch` but continues after failures. |

### 4. Retry Transient Failures

```ts
import { withRetry, submitAndWatch } from "@parity/product-sdk-tx";

const result = await withRetry(
  () => submitAndWatch(tx, signer),
  { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 15_000 },
);
```

## Error Handling

All tx errors extend `TxError`:

```ts
import {
  TxError, TxTimeoutError, TxDispatchError,
  TxSigningRejectedError, TxDryRunError, TxBatchError,
} from "@parity/product-sdk-tx";

try {
  const result = await submitAndWatch(tx, signer);
} catch (e) {
  if (e instanceof TxSigningRejectedError) {
    // User rejected signing in wallet
  } else if (e instanceof TxDispatchError) {
    console.log(e.formatted); // e.g., "Balances.InsufficientBalance"
  } else if (e instanceof TxTimeoutError) {
    console.log(`Timed out after ${e.timeoutMs}ms`);
  } else if (e instanceof TxError) {
    // Catch-all for any tx error
  }
}
```

## Dev Signers for Testnet

```ts
import { createDevSigner, getDevPublicKey } from "@parity/product-sdk-tx";

// Available names: "Alice" | "Bob" | "Charlie" | "Dave" | "Eve" | "Ferdie"
const alice = createDevSigner("Alice");
const result = await submitAndWatch(tx, alice);
```

## SignerManager: Multi-Provider Account Management

```ts
import { SignerManager } from "@parity/product-sdk-signer";

const manager = new SignerManager({
  ss58Prefix: 42,
  dappName: "my-app",
});

// Subscribe to state changes
const unsub = manager.subscribe((state) => {
  console.log(state.status, state.accounts, state.selectedAccount);
});

// Connect to the Host API (default). For testing, pass "dev": manager.connect("dev")
const result = await manager.connect();

if (result.ok) {
  // Request a product account — its signer routes through
  // `host_create_transaction` (PR #96), which preserves arbitrary signed
  // extensions (e.g. `AsPgas` on Paseo Next v2). Required on any chain that
  // ships signed extensions PJS doesn't know about. The legacy path
  // (`manager.selectAccount(...)` + `manager.getSigner()`) routes through PJS
  // and throws `PJS does not support this signed-extension: AsPgas` on such
  // chains — use it only when targeting chains with no unknown extensions.
  const productRes = await manager.getProductAccount("my-app.dot", 0);
  if (productRes.ok) {
    const productAccount = productRes.value;
    const txResult = await submitAndWatch(tx, productAccount.getSigner());
  }
}

manager.destroy();
```

See [`examples/tx-demo/src/main.ts`](../../examples/tx-demo/src/main.ts) for the
full end-to-end pattern (imports, state, init flow).

## KeyManager: Hierarchical Key Derivation

```ts
import { KeyManager } from "@parity/product-sdk-keys";

// Create from a signature
const km = KeyManager.fromSignature(signatureBytes, signerAddress);

// Derive keys for different purposes
const encKey = km.deriveSymmetricKey("doc:123");
const account = km.deriveAccount("app-account", 42);
const kp = km.deriveKeypairs();

// Export for persistence
const raw = km.exportKey();
```

## SessionKeyManager: Mnemonic-Based Session Keys

```ts
import { SessionKeyManager } from "@parity/product-sdk-keys";
import { createLocalKvStore } from "@parity/product-sdk-local-storage";

const store = await createLocalKvStore({ prefix: "session-key" });
const skm = new SessionKeyManager({ store, name: "default" });

const info = await skm.getOrCreate();
// info.mnemonic - BIP39 mnemonic
// info.account  - DerivedAccount with signer
```

## deriveProductAccountPublicKey: Canonical sr25519 Product-Account Derivation

```ts
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";

// Derive the same product-account public key the mobile wallet derives privately
const derivedPubKey = deriveProductAccountPublicKey(
  parentPublicKey,    // 32-byte sr25519 public key
  "playground.dot",   // productId (typically a dotNS name)
  0,                  // derivationIndex
);
```

Mirrors the algorithm used by polkadot-desktop and polkadot-app-android-v2. sr25519 soft derivation is composable on the parent *public* key alone, so external clients (CLI, web hosts) can compute the same address without seeing the secret key. See `references/keys-api.md` for the cross-platform parity constraint on `productId`.

## Common Mistakes

1. **Using dev signers in production** - `createDevSigner` uses the well-known dev mnemonic. Use `SignerManager` for real users.

2. **Confusing signer types** - `submitAndWatch` needs a `PolkadotSigner`, not a `SignerAccount`. Call `account.getSigner()`.

3. **Missing `await` on `submitAndWatch`** - It returns a Promise.

4. **Not handling `TxDispatchError`** - A transaction can be included on-chain but still fail. Always check `result.ok`.

5. **Forgetting account mapping** - EVM contract interactions on Asset Hub require calling `ensureAccountMapped` first.

## Reference Files

- [tx-api.md](references/tx-api.md) - Full `@parity/product-sdk-tx` API reference
- [signer-api.md](references/signer-api.md) - Full `@parity/product-sdk-signer` API reference
- [keys-api.md](references/keys-api.md) - Full `@parity/product-sdk-keys` API reference
