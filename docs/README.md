# @parity/product-sdk-docs

Documentation site for `@parity/product-sdk`. Built with [Nextra 4](https://nextra.site) on Next.js 15, styled with `polkadot-design-system` tokens.

Lives at the repo root (a sibling of `product-sdk/` and `repos/`) and runs as a standalone project. It is not part of the `product-sdk/` pnpm workspace.

## Run locally

```bash
cd docs
pnpm install
pnpm dev
```

Open http://localhost:3000.

> Search (Pagefind) is only populated by the production build. To test search locally, run `pnpm build && pnpm start` instead.

## Build

```bash
pnpm build   # prerender all routes and build the Pagefind search index
pnpm start   # serve the production build locally
```

`postbuild` runs Pagefind against `.next/server/app` and writes the index into `public/_pagefind/`.

## Content

MDX pages live under [`content/`](./content). Sidebar ordering and labels are defined in each directory's `_meta.ts`.

- `content/index.mdx`: landing page
- `content/getting-started/`: installation and quickstart
- `content/api/`: auto-generated API reference (see below)

## API reference generator

The entire `content/api/` tree is generated from TSDoc comments in `product-sdk/packages/**/src/**`. Don't edit the generated files directly. Update the TSDoc at the source, then regenerate.

```bash
pnpm docs:generate   # typedoc --json + custom MDX renderer
pnpm docs:check      # regenerate and fail if content/api drifts from committed state
```

Generator internals:

- Config: [`typedoc.json`](./typedoc.json)
- Renderer: [`scripts/generate-api.ts`](./scripts/generate-api.ts) and `scripts/lib/*`
- TypeDoc JSON output: `generated/api.json` (gitignored)

Every generated file carries a `generated: true` frontmatter marker. The renderer only overwrites files with that marker, so any curated MDX sitting in `content/api/` is preserved automatically.

Output per package: one `index.mdx` overview grouping exports by kind, plus a drill-down page per class, function, interface, type alias, enum, and variable. The umbrella's re-exports link to the leaf package's canonical page instead of duplicating.

## Navbar version badge

The small version badge next to "Product SDK" in the navbar is read from [`product-sdk/packages/sdk/package.json`](../product-sdk/packages/sdk/package.json) at module load (server-side) in [`app/_components/logo.tsx`](./app/_components/logo.tsx). It updates automatically on release.

