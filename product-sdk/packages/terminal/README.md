# @parity/product-sdk-terminal

QR login and signing for CLI and terminal apps, through the Polkadot mobile wallet.

The terminal runs the truapi core, the same Rust pairing host every Polkadot host runs, in a Node worker thread (`@parity/truapi-host/node`). The core owns pairing, the session, allowances and signing. This package gives it what only a terminal has: files on disk, WebSocket chain connections, the pairing QR and the answers to the core's approval prompts.

## Installation

```bash
pnpm add @parity/product-sdk-terminal
```

Requires Node ≥22, for the global `WebSocket` and `node:worker_threads`. Do not bundle the package into one file: the core's worker and WASM load from files beside it.

## Quick start

```ts
import { createSessionSigner, createTerminalAdapter, renderQrCode } from "@parity/product-sdk-terminal";

const adapter = await createTerminalAdapter({ appId: "my-cli.dot" });
try {
    // Restores a stored session, or pairs: print the QR and wait for the phone.
    await adapter.login({
        reason: "Sign in to my-cli",
        onPairing: async (deeplink) => console.log(await renderQrCode(deeplink)),
    });

    // A polkadot-api transaction creator for the product account my-cli.dot/0.
    const signer = await createSessionSigner(adapter);
    const signed = await api.tx.System.remark({ remark }).create(signer);
} finally {
    // The core's thread keeps the process alive until it is stopped.
    await adapter.destroy();
}
```

## API

### `createTerminalAdapter(options): Promise<TerminalAdapter>`

| Option | Default | |
|---|---|---|
| `appId` | required | The product this CLI acts as: a dotNS id ending in `.dot`, `.paseo` or `.testnet`, e.g. `"my-cli.dot"`, or `localhost`. Scopes accounts and storage. |
| `network` | `"paseo-next-v2"` | A name from `TerminalNetworks`, or your own `{ name, people, bulletin, assetHub }` with genesis hashes and endpoints. |
| `storageDir` | `~/.polkadot-apps/<appId>` | This app's own directory. The session lives in `core/` and the product's storage in `product/`, written atomically with mode `0600`. |
| `hostMetadata` | `{ name: appId }` | Name, version and icon shown on the phone while pairing. |
| `approvals` | `approveAll` | Answers the core's approval prompts (see below). |
| `requestTimeoutMs` | `300_000` | Per-call timeout. Pairing alone takes 80 to 110 s on Paseo. |
| `logLevel` | `off` | The core's log level: `error`, `warn`, `info`, `debug` or `trace`. |

The adapter exposes:

- `session`: the paired session (root key, identity, usernames), or `undefined`.
- `authState` and `onAuthStateChange(listener)`: the core's auth state.
- `login({ reason?, onPairing? })`: resolves with the session, pairing first when there is none.
- `logout()`: ends the session and tells the wallet. Rejects when the wallet could not be reached within 30 s; the local session is cleared either way.
- `client(productId?)`: a `@parity/truapi` client for anything not wrapped here.
- `runtime`: the underlying `WorkerPairingHostRuntime`.
- `destroy()`: stops the core. Idempotent.

### Signing

- `createSessionSigner(adapter, publicKey?, options?)`: a `CommonSignerTxCreator` for `appId`, account `0`.
- `createSessionSignerForAccount(adapter, { productId, derivationIndex, publicKey? }, options?)`: the same, for any product account.

Transactions go to the core's `signing.createTransaction` with every extension unchanged, including chain-specific ones such as `AsPgas`. The wallet builds and shows the real extrinsic. `signBytes` goes to `signing.signRaw` with the `Bytes` tag, so the wallet adds the `<Bytes>` wrap once. Signing requests reach the wallet over the statement store, so a failure naming a lapsed allowance throws `AllowanceExpiredError` for it; other refusals throw `Error`.

### Accounts and entropy

- `deriveProductPublicKey(adapter, ref)`: the product account's public key, derived from the subtree key the wallet shares.
- `sessionRootPublicKey(session)`: the wallet's root key.
- `deriveEntropy(adapter, productId, key)`: 32 bytes, stable per wallet, product and key (RFC-0007). The core lowercases and NFC-normalises `productId` first.

### Allowances, statements and Bulletin

- `requestResourceAllocation(adapter, resources, { productId? })`: asks the wallet for allowances. Each outcome is `"Allocated"`, `"Rejected"` or `"NotAvailable"`.
- `getStatementStoreProver(adapter, productId?)` and `submitStatement(adapter, statement, productId?)`: prove statements with the product's statement-store allowance, then submit them.
- `submitPreimage(adapter, data, productId?)`: store data on Bulletin with the product's Bulletin allowance. Returns the preimage key.

The allowance keys stay in the core.

### Approvals

The core asks before it shares the product account, submits to a chain, or signs raw bytes. A terminal has no dialog, so by default `approveAll` approves each prompt once. To ask the user, pass your own:

```ts
const adapter = await createTerminalAdapter({
    appId: "my-cli.dot",
    approvals: async (request) =>
        request.kind === "review"
            ? await confirm(`Allow ${request.review.tag}?`)
            : await confirm(`Grant ${request.permission}?`),
});
```

Device permissions (camera, location and the like) are always refused.

### `defaultStorageDir(appId): string`

The directory an adapter uses when no `storageDir` is given: `~/.polkadot-apps/<appId>`, with characters outside `[A-Za-z0-9_.-]` replaced by `_`.

### `renderQrCode(data, options?): Promise<string>`

Renders a string as a QR code from Unicode blocks, for printing to a terminal.

## Upgrading from 0.13

The terminal moved from `@novasamatech/host-papp` to the truapi core in 0.14.0. Users pair once more. See the 0.14.0 entry in [CHANGELOG.md](./CHANGELOG.md) for every API change.
