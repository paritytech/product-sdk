# Product SDK — talk demo

A deliberately tiny product for the Web3Summit talk. One button per `product-sdk`
component. Each button calls a snippet in [`src/snippets/`](./src/snippets) — and
those snippet files are exactly the code shown on the slides.

| Beat | Button | Snippet | SDK call |
|------|--------|---------|----------|
| 1 | Request access | [`permission.ts`](./src/snippets/permission.ts) | `requestPermission` |
| 2 | Connect | [`connect.ts`](./src/snippets/connect.ts) | `createChainClient` |
| 3 | My account | [`account.ts`](./src/snippets/account.ts) | `SignerManager.connect` |
| 4 | Save / Load | [`storage.ts`](./src/snippets/storage.ts) | `createLocalKvStore` · `CloudStorageClient` |
| 5 | Send → phone | [`transaction.ts`](./src/snippets/transaction.ts) | `submitAndWatch` |

## Run it

```bash
pnpm install
pnpm dev          # serves on http://localhost:4337
```

The SDK is **container-only** — it talks to a host over `postMessage`. So this
app does nothing useful in a plain browser tab. To see it work, open it **inside
a Polkadot host**:

1. Run `pnpm dev` (localhost:4337).
2. In **Polkadot Desktop** or **Polkadot Web**, navigate/point the host to
   `http://localhost:4337`.
3. Click the buttons top-to-bottom. Beat 5 prompts your **phone** to approve.

## Before the talk — verify

- **`talk-demo.dot` in [`transaction.ts`](./src/snippets/transaction.ts)** is a
  placeholder DotNS name. Set it to the name your host build maps to a funded
  product account, or signing will fail.
- **Phone pairing** for beat 5: the only step with an off-device dependency.
  Confirm your phone can reach the host instance during rehearsal.
- **Permission tag** `"ChainSubmit"` is an example; confirm it against the host
  build you demo on.
