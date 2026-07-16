---
name: product-sdk-transactions
description: >
  Submit transactions, connect wallets, manage signers, and handle keys in product-sdk.
  Use when: submitting transactions, integrating Host API signing (Polkadot Desktop/Mobile),
  managing multi-provider wallet accounts, deriving keys, creating dev signers for testnet,
  or wiring QR/mobile sign-in for CLIs.
  Covers @parity/product-sdk-tx (submit/watch), @parity/product-sdk-signer (wallet connection, account
  management, multi-provider signing), @parity/product-sdk-keys (key derivation, session keys), and
  @parity/product-sdk-auth (QR/mobile CLI sign-in + product-account session signers).
---

# Product SDK Transactions, Signing, and Key Management

This skill covers three packages that work together for submitting on-chain transactions:

| Package | Import | Purpose |
|---------|--------|---------|
| tx | `@parity/product-sdk-tx` | Submit, watch, retry transactions |
| signer | `@parity/product-sdk-signer` | Manage signing accounts across providers |
| keys | `@parity/product-sdk-keys` | Derive keys, accounts, and session keys |
| auth | `@parity/product-sdk-auth` | QR/mobile CLI sign-in + product-account session signers |

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
// Returns Result<TxResult, TxError> — success/failure is the `.ok` discriminant.
// Tx failures come back as err(TxError); they do NOT throw.
const result = await submitAndWatch(tx, alice);
if (!result.ok) {
  console.log("Failed", result.error.message);
} else {
  // result.value: TxResult { txHash, ok, block: { hash, number, index }, events, dispatchError? }
  console.log("Success", result.value.block.hash);
}
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
// extractTransaction is sync and returns Result<SubmittableTransaction, TxDryRunError>.
const extracted = extractTransaction(dryRun);
if (!extracted.ok) throw extracted.error; // TxDryRunError
const tx = extracted.value;
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
// result: Result<TxResult, TxError>
// On success, result.value is TxResult { txHash, ok, block: { hash, number, index }, events, dispatchError? }
if (result.ok) {
  console.log(result.value.txHash, result.value.block.hash);
} else {
  console.log(result.error.message); // typed TxError
}
```

### 3. Batch Multiple Transactions

Submit multiple transactions as a single atomic batch — one signing prompt, one fee.

```ts
import { batchSubmitAndWatch } from "@parity/product-sdk-tx";

const tx1 = client.assetHub.tx.Balances.transfer_keep_alive({ dest: addr1, value: 1_000n });
const tx2 = client.assetHub.tx.Balances.transfer_keep_alive({ dest: addr2, value: 2_000n });
const tx3 = client.assetHub.tx.System.remark({ remark: Binary.fromText("hello") });

// Returns Result<TxResult, TxError>, same as submitAndWatch.
const result = await batchSubmitAndWatch([tx1, tx2, tx3], client.assetHub, signer, {
  onStatus: (status: TxStatus) => updateUI(status),
});
if (!result.ok) {
  handleBatchFailure(result.error); // e.g. TxBatchError
  return;
}
console.log("Batch finalized", result.value.block.hash);
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

All tx errors extend `TxError`. `submitAndWatch` / `batchSubmitAndWatch` do NOT
throw on tx failure — they return `err(TxError)`. Branch on `result.ok` and
narrow the typed `result.error`:

```ts
import {
  TxError, TxTimeoutError, TxDispatchError,
  TxSigningRejectedError, TxDryRunError, TxBatchError,
} from "@parity/product-sdk-tx";

const result = await submitAndWatch(tx, signer);
if (!result.ok) {
  const e = result.error;
  if (e instanceof TxSigningRejectedError) {
    // User rejected signing in wallet
  } else if (e instanceof TxDispatchError) {
    console.log(e.formatted); // e.g., "Balances.InsufficientBalance"
  } else if (e instanceof TxTimeoutError) {
    console.log(`Timed out after ${e.timeoutMs}ms`);
  } else if (e instanceof TxError) {
    // Catch-all for any tx error
  }
} else {
  // result.value is the TxResult
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

## CLI Sign-In and Session Signers (`@parity/product-sdk-auth`)

For **command-line products**, `@parity/product-sdk-auth` is the shared sign-in
layer: QR/mobile pairing, persisted sessions, a sign-out flow, and a
product-account signer — all bound to a product via injected config (no per-CLI
`config.ts`). It sits on top of `@parity/product-sdk-terminal` and derives the
product account with the same *derivation scheme* the mobile wallet uses (via
terminal's `deriveProductPublicKey`, the CLI counterpart of the keys package's
`deriveProductAccountPublicKey` below).

> The signer it returns signs as the **product account** (`/product/{productId}/{index}`),
> NOT the wallet's selected account — so its address matches the funded /
> allowance-granted account. This is the CLI analogue of `SignerManager.getProductAccount()`.

### Getting a signer

`resolveSigner` is the one call to reach for: it returns a dev signer when a
`--suri` is supplied, otherwise the persisted QR session's product-account
signer.

```ts
import { createAuthClient, resolveSigner } from "@parity/product-sdk-auth";
import { submitAndWatch } from "@parity/product-sdk-tx";

// 1. Bind an auth client to your product's config (inject per-product values).
const authClient = createAuthClient({
  dappId: "playground",              // scopes ~/.polkadot-apps/${dappId}_* + SSO pairing
  productId: "playground.dot",       // derives the product account
  derivationIndex: 0,                // 0 = default product account
  peopleEndpoints: ["wss://<people-rpc>"],
});

// 2. Get a PolkadotSigner — dev SURI if provided, else the persisted QR session.
//    `suri` accepts a dev name (//Alice) OR a full BIP-39 mnemonic with an
//    optional //<path> derivation suffix. Throws SignerNotAvailableError if
//    neither a suri nor a session is available (prompt the user to `login`).
const resolved = await resolveSigner(authClient, { suri: process.env.SURI }); // suri optional
try {
  const result = await submitAndWatch(tx, resolved.signer);
  // resolved.address / resolved.addresses (root/product/H160) / resolved.source ("dev" | "session")
  // resolved.userSession is present only for QR/mobile sessions (undefined for dev signers).
} finally {
  resolved.destroy();                // REQUIRED: releases the session WebSocket
}
```

### First-time login (QR flow)

`connect()` + `waitForLogin()` only **authenticate and persist** the session —
they do not return a signer. After a successful login, call `resolveSigner()`
(or `authClient.getSessionSigner()`) to actually sign.

```ts
const conn = await authClient.connect();
if (conn.kind === "existing") {
  console.log("Already signed in as", conn.address);
} else {
  // Render the QR (terminal UI helpers live under the `/ui` subpath so headless
  // consumers don't pull terminal-rendering deps).
  console.log(conn.qrCode);
  const address = await authClient.waitForLogin(conn.login, (s) => console.log(s.step));
}
// Session is now persisted — resolveSigner()/getSessionSigner() will find it.
```

```ts
// Status formatters + QR renderer (separate entrypoint):
import { renderLoginStatus, renderLogoutStatus, renderQrCode } from "@parity/product-sdk-auth/ui";
```

### Sign-out (logout)

Mirror image of the login flow: find the paired session, disconnect it (notifies
the mobile app), and clear the local `${dappId}_*` files.

```ts
const handle = await authClient.findSession();
if (!handle) {
  console.log("Not signed in.");
} else {
  await authClient.waitForLogout(handle, (s) => console.log(renderLogoutStatus(s)));
  // LogoutStatus.step: "disconnecting" | "success" | "partial" (local cleared, remote unreachable) | "error"
}
```

### Resource allocation (RFC-0010)

A fresh session needs allowances before it can sign (statement store / Bulletin /
smart-contract sponsoring). The mobile wallet prompts the user to approve. By
default `requestAllocation` requests `DEFAULT_RESOURCES` — `BulletInAllowance`,
`StatementStoreAllowance`, and `SmartContractAllowance` for the default (index 0)
product account.

```ts
import { DEFAULT_RESOURCES, summarizeOutcomes } from "@parity/product-sdk-auth";

// resolved.userSession is only set for QR/mobile sessions (not dev signers).
const outcomes = await authClient.requestAllocation(resolved.userSession!); // DEFAULT_RESOURCES, onExisting "Ignore"
const { granted, rejected, unavailable } = summarizeOutcomes(outcomes, DEFAULT_RESOURCES);
```

> **When to use which:** `SignerManager.getProductAccount()` is for **in-host / web**
> products (Host API). `@parity/product-sdk-auth` is for **standalone CLIs** that pair
> with a phone over QR. Both end at a `PolkadotSigner` you pass to `submitAndWatch`.

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

4. **Not handling `TxDispatchError`** - A transaction can be included on-chain but still fail. This comes back as `err(TxDispatchError)`, not a thrown error — always branch on `result.ok` and inspect `result.error`.

5. **Forgetting account mapping** - EVM contract interactions on Asset Hub require calling `ensureAccountMapped` first.

6. **Not calling `resolved.destroy()`** (auth) - session signers own a WebSocket that keeps the Node event loop alive; the CLI won't exit cleanly until it's torn down. Call it in a `finally`.

7. **Signing on a fresh session without allocations** (auth) - per the package's own note, RFC-0010 allowances are needed before a fresh session can sign (statement store / Bulletin / smart-contract). Run `authClient.requestAllocation(session)` once after first login and let the user approve it on the phone.

## Reference Files

- [tx-api.md](references/tx-api.md) - Full `@parity/product-sdk-tx` API reference
- [signer-api.md](references/signer-api.md) - Full `@parity/product-sdk-signer` API reference
- [keys-api.md](references/keys-api.md) - Full `@parity/product-sdk-keys` API reference
- [auth-api.md](references/auth-api.md) - Full `@parity/product-sdk-auth` API reference (CLI sign-in, session signers, logout, RFC-0010 allocations)
