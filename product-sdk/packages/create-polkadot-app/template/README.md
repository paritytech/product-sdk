# Polkadot App Starter

A starter app built with [`@parity/product-sdk-*`](https://github.com/paritytech/product-sdk). The SDK packages are installed and ready to wire up (14 of 15 — `terminal` is omitted since it targets CLI/QR-pairing apps, not web).

## Quick start

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173 and edit `src/App.tsx` to start building.

## What's inside

```
src/
├── main.tsx          React root
├── App.tsx           your app — start here
└── lib/              SDK integration points (fill in as you need them)
    ├── auth.ts       wallet sign-in via SignerManager
    ├── keys.ts       persistent session signer via SessionKeyManager
    ├── chain.ts      chain connection via getChainAPI
    ├── crypto.ts     AES-GCM encryption helpers
    ├── bulletin.ts   encrypted storage on Bulletin Chain
    ├── storage.ts    local host-aware key-value cache
    └── registry.ts   typed contract bindings (guided stub)
```

Each `src/lib/*.ts` is a stub with a comment pointing at the canonical pattern. Open the file and follow the reference link to fill it in.

## Scripts

```bash
pnpm dev       # start the Vite dev server
pnpm build     # type-check + build → dist/
pnpm preview   # serve dist/ locally to verify
```

## Deploy

The `dist/` directory is a static site. Deploy it to Bulletin Chain via [`bulletin-deploy`](https://github.com/paritytech/dotns-sdk), to GitHub Pages, Vercel, Cloudflare Pages, or any static host.

## Learn more

- [@parity/product-sdk repo](https://github.com/paritytech/product-sdk)
- Demo apps for each SDK surface: `examples/` in the product-sdk repo
