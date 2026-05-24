# Guidance for Claude Code

Working notes for anyone driving this repo through Claude Code. Skim, don't memorize — every rule here links out to the deeper doc.

## Repo layout

This is a meta-repo with two top-level directories:

- `product-sdk/` — the workspace where all packages live. Cd into here before running any `pnpm` command.
- `docs/` — the docusaurus site, deployed separately.

Inside `product-sdk/`:

- `product-sdk/packages/*` — published `@parity/product-sdk-*` packages. Edit here for any consumer-visible change.
- `product-sdk/examples/*` — demo apps + Playwright e2e specs. Not published.
- `product-sdk/skills/*` — product-API knowledge, consumed by Claude Code via the `Skill` tool. Add a skill when there's reusable "how to use this part of the SDK" content.
- `product-sdk/pending-changesets/` — changesets parked while their PR is still in flight. See [`product-sdk/pending-changesets/README.md`](./product-sdk/pending-changesets/README.md).
- `product-sdk/.changeset/` — changesets ready to ship on the next merge to `main`.
- `product-sdk/local-docs/` — design notes, evaluations, anything that doesn't ship to npm.
- `product-sdk/RELEASES.md` — the canonical release / changeset doc. Read this before authoring a changeset.

## Build / test / lint

Run from `product-sdk/`:

```bash
pnpm install                                  # workspace install
pnpm -r build                                 # build every package
pnpm -r test                                  # run every package's unit tests
pnpm check                                    # biome lint + format check (this is what CI runs)
pnpm format                                   # auto-fix format issues
pnpm test:e2e                                 # all e2e demos under examples/*

pnpm --filter "@parity/product-sdk-host" build
pnpm --filter "@parity/product-sdk-signer" test
```

For e2e on a single demo: `pnpm --filter "@parity/product-sdk-tx-demo" test:e2e`.

## Changesets

Every PR that changes a published artifact needs a changeset. See [`product-sdk/RELEASES.md#when-does-a-pr-need-a-changeset`](./product-sdk/RELEASES.md#when-does-a-pr-need-a-changeset) for the exact criteria. Two important quirks:

- Park work-in-progress changesets in `pending-changesets/`, not `.changeset/` — anything under `.changeset/` ships on the next merge to `main`, even if the PR that created it is unfinished.
- When any constituent gets a `minor` bump, **also list `@parity/product-sdk` as `minor`** in the same changeset. Otherwise the umbrella cascades only at patch level.

## PR workflow

- **Prefer `git pull origin main` over `git rebase main`** when catching a branch up. Rebase forces a force-push that desyncs anyone else who has the branch checked out.
- **Trust CI over local test failures.** Some tests fail on darwin due to ESM-resolution quirks in transitive deps that don't reproduce on Linux. If CI is green, the failure is environmental — don't flag it as a blocker.
- **Run `pnpm check` before pushing**, and run `pnpm format` only if `pnpm check` actually flags something. Don't preemptively reformat after a codegen rewrite.
- **Don't commit without being asked** — same default as Claude Code's general rule.

## Codebase gotchas

- **`product-sdk/packages/host/src/truapi.ts` is not `@parity/truapi`.** Despite the name, this file is the accessor for whichever upstream host-API wrapper the catalog currently points at. The `TruApi = any` alias is for that wrapper's `hostApi` object. See [`product-sdk/local-docs/truapi-evaluation.md`](./product-sdk/local-docs/truapi-evaluation.md) for the actual `@parity/truapi` package and how it relates.
- **`product-sdk/packages/descriptors/chains/*/generated/`** is gitignored. Don't try to read or edit it — it's emitted by `pnpm generate` and packed at publish time. Source of truth is the per-chain `.papi/polkadot-api.json`.
- **CHANGELOG files are historical.** A mass rename (e.g. of a dep) should not sweep them — the names that were current at release time should stay frozen.
- **The upstream host-API wrapper is volatile.** It gets renamed, republished, and occasionally replaced wholesale. Check `product-sdk/pnpm-workspace.yaml` for the current dep name and version before assuming. The auto-bumper (`.github/workflows/product-sdk-deps-check.yml`) tracks the latest stable; prereleases are pinned manually.
- **e2e specs may carry `TODO(truapi-migration)` skips.** These are real and load-bearing — track them via the open issue rather than randomly unskipping.
- **The umbrella `@parity/product-sdk` package re-exports many smaller packages.** A bundle-size measurement on the umbrella reflects the transitive graph of everything it touches, not its own code.

## Where to look first for X

| You're looking for | Start here |
|---|---|
| Sign a transaction / signer lifecycle | `product-sdk/packages/signer/src/signer-manager.ts`, `product-sdk/packages/signer/src/providers/host.ts` |
| Host API surface | `product-sdk/packages/host/src/truapi.ts`, `product-sdk/packages/host/src/container.ts` |
| Permission / resource-allocation ergonomics | `product-sdk/packages/host/src/permissions.ts` |
| PAPI chain bindings | `product-sdk/packages/descriptors/chains/<chain>/.papi/polkadot-api.json` |
| Contracts wrapper / dry-runs | `product-sdk/packages/contracts/src/wrap.ts` |
| Bulletin chain client | `product-sdk/packages/bulletin/src/` |
| Test SDK conventions | `@parity/host-api-test-sdk` (separate repo, vendored as catalog dep) |
| Release pipeline | `.github/workflows/product-sdk-release.yml`, `product-sdk/RELEASES.md` |
| Descriptor drift detection | `.github/workflows/product-sdk-descriptors-drift.yml`, `product-sdk/packages/descriptors/README.md` |
| Catalog auto-bumper | `.github/workflows/product-sdk-deps-check.yml` |

## Don't touch without good reason

- Published CHANGELOGs (historical record).
- The upstream host-API wrapper catalog pin without checking with the owner — it's intentionally exact / load-bearing for whatever the current wire compatibility window is.
- `product-sdk/packages/descriptors/chains/*/generated/` (regenerated by tooling).
- The `RELEASES.md` umbrella-bump policy (prior release waves are locked into this convention).
- `.github/workflows/product-sdk-release.yml` (release pipeline — coordinate with the release owner before changing).

## Skills

When the user's question matches a skill, invoke it via the `Skill` tool rather than reimplementing the answer from source. Active skills:

- `product-sdk-app-builder` — scaffolding a new product app.
- `product-sdk-chain-connection` — connecting to a chain.
- `product-sdk-transactions` — signing + submitting txs.
- `product-sdk-contracts` — contract calls (queries, txs).
- `product-sdk-bulletin` — bulletin chain client.
- `product-sdk-statement-store` — statement store.
- `product-sdk-utilities` — address, crypto, logger, local-storage, utils.
- `migrating-to-product-sdk` — porting from legacy `@polkadot-apps/*`.
