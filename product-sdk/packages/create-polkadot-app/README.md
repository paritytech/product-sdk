# create-polkadot-app

Scaffold a new Polkadot app with `@parity/product-sdk-*` already wired up.

## Usage

```bash
npm create polkadot-app my-app
# or
pnpm create polkadot-app my-app
# or
yarn create polkadot-app my-app
```

If you don't pass a name, the CLI will prompt you.

## What you get

A React + Vite + TypeScript project with all 13 `@parity/product-sdk-*` packages installed and ready to use. The `src/lib/` directory has empty stubs you fill in as your app needs them:

- `auth.ts` — wallet sign-in (SignerManager)
- `chain.ts` — chain connection (getChainAPI)
- `crypto.ts` — AES-GCM encryption helpers
- `bulletin.ts` — encrypted storage on Bulletin Chain
- `storage.ts` — local host-aware key-value cache
- `registry.ts` — typed contract bindings

Run `pnpm dev` and edit `src/App.tsx` to start building.

## License

Apache-2.0
