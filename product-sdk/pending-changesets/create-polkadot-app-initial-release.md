---
"create-polkadot-app": minor
---

**Initial release: scaffolding CLI for Polkadot apps powered by `@parity/product-sdk-*`.**

Post-publish invocation:

```
npm  create polkadot-app my-app
pnpm create polkadot-app my-app
yarn create polkadot-app my-app
```

Produces a 14-file React + Vite + TypeScript project with all 13 SDK packages installed and ready to use. Five `src/lib/*.ts` files ship pre-wired as singletons (signer, chain-client, crypto, bulletin, storage); one is a guided stub (contracts — needs per-app `cdm.json`). `App.tsx` includes a working `<WalletConnect />` demo using `SignerManager` + `truncateAddress`, clearly bounded between comment markers so read-only apps can remove it in three surgical edits.

Closes #44.
