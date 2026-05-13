---
name: migrating-to-product-sdk
description: >
  Use when migrating a product codebase to @parity/product-sdk — detects
  legacy stacks (polkadot-apps, novasamatech, hand-rolled crypto/IPFS,
  polkadot-api 1.x) in the target repo, decides which migration areas
  apply, writes a per-repo migration spec, then hands off to writing-plans.
---

# Migrating to @parity/product-sdk

This skill is a **discovery + spec orchestrator**. It does NOT edit code,
NOT run tests, and NOT commit. Its only output is a written migration
spec at `docs/superpowers/specs/`. After the spec is approved, it hands
off to `writing-plans` which produces an executable implementation plan.

The skill composes with the seven existing SDK skills (one per package
area) and references them by name rather than duplicating their
content:

- `product-sdk-app-builder` — bootstrap, `createApp`
- `product-sdk-chain-connection` — `getChainAPI` / `createChainClient`
- `product-sdk-transactions` — tx + signer + keys
- `product-sdk-utilities` — address + crypto + utils + storage + logger
- `product-sdk-bulletin` — `BulletinClient`, upload / fetch
- `product-sdk-contracts` — `ContractManager`, `createContract`
- `product-sdk-statement-store` — pub/sub

## When this skill applies

Invoke when any of:

- User asks to migrate a product to `@parity/product-sdk`.
- The target repo's `package.json` (any workspace) declares any of:
  `@polkadot-apps/*`, `@novasamatech/product-sdk`, `polkadot-api@^1.x`,
  `@skiff-org/skiff-crypto`, `tweetnacl`, `@polkadot-labs/hdkd-helpers`,
  `helia` / `@helia/*`.
- A GitHub issue or PR in the repo has "migrate to @parity/product-sdk"
  in the title or body.

## Hard constraints

- ❌ **Never commit.** Not during discovery, not after writing the spec.
  The user commits manually.
- ❌ **Never edit code.** The skill's role is discovery + spec writing
  only. Code edits happen later in `executing-plans`.
- ❌ **Never skip a CHECKPOINT.** Both the decision matrix (Phase 2)
  and the spec (Phase 3) require explicit user approval before
  advancing.
- ✅ **Always run discovery first.** No "I already know what this
  repo needs" — every invocation inspects the actual target repo.

## Phase 1 — Discovery

Inspect the target repo and produce an in-memory discovery report.
The report drives every decision in Phase 2.

### What to read

1. **Every `package.json` in the workspace.** Use `find . -name package.json
   -not -path '*/node_modules/*'` to enumerate. For each, extract: the
   `dependencies`, `devDependencies`, and any `pnpm.overrides` /
   `overrides`. Also note the package's `name` and `private` flag.

2. **The lockfile.** Confirm the resolved version of `polkadot-api` (1.x
   vs 2.x is decision-relevant) and check whether
   `@polkadot-api/json-rpc-provider@0.0.4` is present anywhere
   transitively — if yes, gotcha G1 applies.

3. **The `.papi/descriptors/package.json`** (if present) — note the
   catalog source (`@parity` / `@novasamatech`) and version.

4. **`tsconfig.json` and framework config** — to detect the framework:
   `next.config.*` → Next.js; `nuxt.config.*` → Nuxt; `vite.config.*` →
   Vite; presence of `bin` in `package.json` and no framework config →
   CLI.

### Grep checklist (legacy patterns)

Run these greps against `src/`, `app/`, `apps/`, `packages/`,
`lib/` — whichever the repo uses. Report counts and example files for
each non-zero result.

```
# Direct legacy package imports
grep -rEn "from '@polkadot-apps/" --include='*.ts' --include='*.tsx' --include='*.vue' --include='*.js'
grep -rEn "from '@novasamatech/product-sdk" --include='*.ts' --include='*.tsx' --include='*.vue' --include='*.js'
grep -rEn "from '@skiff-org/skiff-crypto'" --include='*.ts' --include='*.tsx'
grep -rEn "from 'tweetnacl'" --include='*.ts' --include='*.tsx'
grep -rEn "from '@polkadot-labs/hdkd-helpers'" --include='*.ts' --include='*.tsx'
grep -rEn "from 'helia'|from '@helia/" --include='*.ts' --include='*.tsx'

# Legacy PAPI 1.x patterns
grep -rEn "polkadot-api/ws-provider/(web|node)" --include='*.ts'
grep -rEn "withPolkadotSdkCompat" --include='*.ts'
grep -rEn "\.asHex\(\)|Binary\.fromBytes\(" --include='*.ts'
grep -rEn "api\.event\.\w+\.\w+\.watch\(" --include='*.ts'

# Hand-rolled crypto / encoding
grep -rEn "crypto\.subtle\.digest" --include='*.ts'
grep -rEn "padStart\(2, *'0'\)" --include='*.ts'
grep -rEn "createClient\b|createPapiProvider\b" --include='*.ts'
grep -rEn "getAccountsProvider\b" --include='*.ts'

# Storage / Bulletin / Contracts patterns
grep -rEn "localStorage\.(get|set|remove)Item" --include='*.ts' --include='*.tsx' --include='*.vue'
grep -rEn "createInkSdk\b|@polkadot-api/sdk-ink" --include='*.ts'
```

### Container detection

Check whether the repo already uses `isInsideContainer` or
`isInsideContainerSync` (from `@parity/host-api` or
`@parity/product-sdk-host`). If yes, the repo is **dual** (container +
standalone). If no, classify by framework: CLI / web-only is
**standalone**; Polkadot Desktop / Mobile embed is **container-only**.

### Existing migration work

Run: `gh pr list --search 'migrate to @parity/product-sdk in:title'`
and `gh issue list --search 'migrate to @parity/product-sdk in:title'`.
Link any matches in the spec.

### Discovery report shape

The report is an in-memory object the skill carries into Phase 2.
Include at minimum:

- `framework`: one of `next` / `nuxt` / `vite` / `cli` / `mixed`
- `workspaceStructure`: `single-app` | `monorepo` with N workspaces
- `containerDetection`: `dual` | `container-only` | `standalone`
- `legacyStacks`: list of detected stacks with example files
- `papiVersion`: resolved version from lockfile
- `tests`: detected test runner + count
- `existingPr`: link or `null`
