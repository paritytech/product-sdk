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

A React + Vite + TypeScript project with the `@parity/product-sdk-*` packages installed and ready to use (14 of 15 — `terminal` is omitted since it targets CLI/QR-pairing apps, not web). The `src/lib/` directory has stubs you fill in as your app needs them:

- `auth.ts` — wallet sign-in (SignerManager)
- `keys.ts` — persistent session signer (SessionKeyManager)
- `chain.ts` — chain connection (getChainAPI)
- `crypto.ts` — AES-GCM encryption helpers
- `bulletin.ts` — encrypted storage on Bulletin Chain
- `storage.ts` — local host-aware key-value cache
- `registry.ts` — typed contract bindings (guided stub — drop in your `cdm.json`)

Run `pnpm dev` and edit `src/App.tsx` to start building.

## License

Apache-2.0
