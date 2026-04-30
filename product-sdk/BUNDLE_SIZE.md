# Bundle Size

Every PR that touches `product-sdk/**` runs the bundle-size benchmark and posts a sticky comment with the impact per package. The goal is to keep the SDK small and to catch tree-shaking regressions early.

## What gets measured

For every `@parity/product-sdk-*` package and every subpath export of `@parity/product-sdk` and `@parity/product-sdk-descriptors`, three numbers are recorded:

| Metric | How it's measured | What it tells you |
|---|---|---|
| **Ship** | Raw + gzip + brotli of `dist/<entry>.js` | What npm sends per file |
| **Bundled** | esbuild bundle of `import * as M from "<pkg>"` | Consumer ceiling — full cost when every export is reachable |
| **Shaken** | esbuild bundle of `import { firstExport } from "<pkg>"` | Tree-shaken cost of importing one symbol |

The ratio `shaken / bundled` is the **tree-shake ratio**. A low ratio is good — most of the package falls away when consumers only use one symbol. A ratio near 100% means tree-shaking is broken (top-level side effects, eager class instantiation, or `sideEffects: true`).

## CI behaviour

`product-sdk-bundle-size.yml` runs on every PR that touches `product-sdk/`:

1. Builds the **base** branch and measures.
2. Builds the **PR head** and measures.
3. Diffs the two reports and posts a sticky comment.
4. Fails the job if any package's bundled size grows beyond the fail threshold.

Thresholds (deliberately loose for v1, will tighten with data):

| Severity | Bundled growth | Notes |
|---|---|---|
| 🟢 ok | <10% and <5 KB | |
| 🟡 warn | ≥10% or ≥5 KB | Comment shows yellow row, job still passes |
| 🔴 fail | ≥20% or ≥15 KB | Job fails |

For deps-dominated entries (>100 KB baseline), only the percentage applies — a +5 KB swing in a 1 MB bundle is noise. For small entries (<100 KB), absolute byte budgets kick in to catch slow drift.

## Local commands

```bash
# Measure once and write bundle-size.json + bundle-size.md
pnpm bench

# Compare current vs an earlier snapshot (used by CI)
pnpm bench:compare
```

`pnpm bench` writes:
- `bundle-size.json` — committed baseline, the source of truth for the SDK's current size.
- `bundle-size.md` — gitignored markdown table for human eyes.

## When to update the baseline

The committed `bundle-size.json` represents the SDK's current measured size. **Update it** when you intentionally land a change that grows or shrinks bundles — adding a feature, swapping a dep, ripping out dead code.

Regenerate using **Node 24** to match CI — V8/zlib output can shift slightly across Node majors, so a baseline captured on a different version will show phantom drift in PR comparisons run on `main`.

```bash
pnpm build
pnpm bench
git add product-sdk/bundle-size.json
git commit -m "chore: refresh bundle-size baseline"
```

The CI compare uses `<base-branch>` vs `<PR-head>` directly, so the committed baseline isn't used to gate PRs. It exists so we can track the SDK's size on `main` over time and answer "did this release get bigger?"

## Debugging a regression

If your PR comment shows a 🟡 or 🔴 entry:

1. **Check the `Bundled` column** — that's the consumer-cost number. If it grew, something you imported pulled in more code.
2. **Check the `Shake ratio`** — if it jumped (e.g. 5% → 95%), you accidentally introduced a side effect that defeats tree-shaking. Common causes:
   - A new top-level statement with effects (`const x = doSomething()` outside a function).
   - A package marked `sideEffects: true` somewhere in the dep chain.
   - A barrel that re-exports an entire module via `import "x"` (no binding pulled).
3. **Inspect locally** with esbuild's metafile:
   ```bash
   cd product-sdk
   pnpm build
   node -e '
     import("esbuild").then(async ({ build }) => {
       const r = await build({
         stdin: { contents: `import { Thing } from "@parity/product-sdk-foo"; globalThis.x = Thing;`, resolveDir: "scripts/bench-consumer" },
         bundle: true, format: "esm", platform: "browser", target: "es2022",
         minify: true, write: false, metafile: true,
       });
       require("fs").writeFileSync("meta.json", JSON.stringify(r.metafile));
     });
   '
   ```
   Then drop `meta.json` into <https://esbuild.github.io/analyze/> to see who pulled what.

## How the script works

`scripts/bench-bundle.mjs` discovers every workspace package whose name starts with `@parity/product-sdk` and walks its `exports` map. For each entry, it:

1. Reads the dist file directly → ship/gzip/brotli.
2. Synthesises an entry `import * as M from "<pkg>"; globalThis.__pin = M;` and runs esbuild against `scripts/bench-consumer/` (a workspace package that depends on every SDK package, so esbuild can resolve bare imports through pnpm's per-package linking).
3. Repeats with a single named import for the shaken measurement.

The `bench-consumer` is a private workspace package that exists solely to give esbuild a `node_modules` to resolve through. It is never published.
