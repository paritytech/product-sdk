# @parity/product-sdk-docs

Documentation site for `@parity/product-sdk`. Built with [Nextra 4](https://nextra.site) on Next.js 15, styled with the `polkadot-design-system` tokens.

## Run locally

From the monorepo root:

```bash
pnpm install
pnpm --filter @parity/product-sdk-docs dev
```

Or from this directory:

```bash
cd product-sdk/docs
pnpm dev
```

Open http://localhost:3000.

## Build

```bash
pnpm --filter @parity/product-sdk-docs build
pnpm --filter @parity/product-sdk-docs start
```

Output is a static export — 13 prerendered routes. `start` serves `.next/` locally for smoke-testing the production build.

## Editing content

MDX pages live under [`content/`](./content). Sidebar ordering and labels are defined in the `_meta.ts` file inside each directory.

- `content/index.mdx` — landing
- `content/getting-started/` — install, quickstart, runtime environment
- `content/core-concepts/` — app lifecycle, logging
- `content/api/sdk/` — umbrella `@parity/product-sdk` reference

API reference pages follow one shape: **Signature → Parameters table → Returns → Examples → Notes**. Keep prose imperative and terse; lead parameter rows with type.

## Design system

Semantic tokens live in [`app/globals.css`](./app/globals.css) (Tailwind v4 `@theme` block + `.dark` overrides). Never use raw Tailwind colors (`bg-white`, `text-gray-500`, `dark:bg-…`) — use the semantic classes (`bg-surface-container`, `text-primary`, `rounded-container`). The `.dark` class on `<html>` swaps modes; no `dark:` prefix needed in components.

Logo SVGs in [`public/`](./public) are copies from the `polkadot-design-system` skill — update them there, then copy over.
