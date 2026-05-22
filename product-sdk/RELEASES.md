# Releases

This project uses [changesets](https://github.com/changesets/changesets) for
versioning and publishing. The release workflow at
[`.github/workflows/product-sdk-release.yml`](../.github/workflows/product-sdk-release.yml)
runs on every push to `main` and publishes whenever it finds at least one
changeset file under `.changeset/`.

## TL;DR

1. Author your changeset on a feature branch — park it in
   [`pending-changesets/`](./pending-changesets/) while the work is
   in progress.
2. On the PR that closes the work, move the changeset into `.changeset/`.
3. Merging that PR to `main` is what triggers the release.

## When does a PR need a changeset?

**Rule of thumb:** if your PR will change the published artifact for any
`@parity/product-sdk-*` package, it needs a changeset. If it touches
nothing a consumer will ever install, it doesn't.

### Needs a changeset

- Any change under `packages/*/src/` that's not behind `if (import.meta.vitest)`.
- Any change to a package's `package.json` — bumping a dep version, renaming
  a dep, adding or removing `peerDependencies` / `exports` / `files`.
- Any change to a package's public README.md, since READMEs ship to npm.
- Any catalog entry change in `pnpm-workspace.yaml` that flows through
  `catalog:` references in published packages.
- Any rename, removal, or signature change to an exported symbol — even
  if you're "only" cleaning up. Consumers see it.

Bump type rule:
- **`patch`** — bug fix, no public-API change.
- **`minor`** — new public API surface; or, under pre-1.0 semver,
  any breaking change (since major is still `0`). Most of our packages
  are pre-1.0, so most breaking changes go out as `minor`.
- **`major`** — reserved for post-1.0 breaking changes.

### Doesn't need a changeset

- Test-only changes (`*.test.ts`, anything under `examples/`, anything in
  the `if (import.meta.vitest)` block of a source file).
- CI workflow / GitHub Action changes under `.github/`.
- Docs that don't ship: anything in `local-docs/`, `pending-changesets/`,
  `RELEASES.md` itself, root-level `*.md` files not bundled into a
  package.
- `skills/` updates (consumed by tooling, not published).
- CHANGELOG-only edits to correct an already-published entry (this fixes
  the historical record without bumping the version).
- Lockfile-only refreshes that don't change any published artifact.

### When in doubt

Run `pnpm changeset status` on your branch before opening the PR. If it
lists no packages and the diff touches `packages/*/src/`, you probably
need one. If it lists packages that *shouldn't* be bumping, your
changeset over-specifies — narrow it.

### The umbrella exception

The "every PR needs one" rule has one wrinkle worth knowing: when a
constituent package gets a minor bump, you must **also** explicitly list
`@parity/product-sdk` (the umbrella) at minor in the same changeset.
Otherwise the umbrella cascades only at patch level and ends up at a
lower version than the child it re-exports. See
[Umbrella policy](#umbrella-parityproduct-sdk-policy) below.

## The two-directory pattern

| Directory | Tracked by `@changesets/cli`? | Use for |
|---|---|---|
| `.changeset/` | **Yes** — every `.md` file (other than `README.md` and dotfiles) is consumed on the next release | Changesets ready to publish on the next merge to `main` |
| `pending-changesets/` | No — sibling directory, invisible to the CLI | Changesets parked while the underlying PR is still in review or pending dependency work |

Put differently: anything under `.changeset/` will go out on the next
release. If you authored a changeset on a feature branch but the PR
is still iterating, parking it under `.changeset/` means an unrelated
merge could ship your unfinished work. Stage it in
`pending-changesets/` instead and promote it on the closing PR.

See [`pending-changesets/README.md`](./pending-changesets/README.md)
for the details — including why we can't nest a subdirectory under
`.changeset/` (the CLI parses subdirs as legacy v1 changesets).

## Authoring a changeset

```bash
# From the product-sdk/ directory:
pnpm changeset
```

You'll be prompted for:

- **Affected packages** — every workspace package that needs a version
  bump in this wave. Don't forget cascades: if package A consumes
  package B via `workspace:*` and B's public API changes, A may need
  to bump too (changesets-cli handles transitive cascades automatically,
  but only at the patch level — see "Umbrella policy" below).
- **Bump type per package**:
  - `patch` — bug fix; no public-API change.
  - `minor` — new public API surface; or, under pre-1.0 semver,
    breaking changes (since major is still `0`). Most of our
    packages are pre-1.0.
  - `major` — reserved for post-1.0 breaking changes.
- **Summary** — one sentence. The body renders into the per-package
  `CHANGELOG.md`, so write it for your future self trying to remember
  what changed.

### Naming

`pnpm changeset` generates files like `funny-rabbits-paint.md`. Rename
to something descriptive in kebab-case before committing — past waves
used names like:

- `paseo-next-v2-swap.md`
- `expose-query-failure-value.md`
- `host-request-resource-allocation.md`
- `terminal-papi-native-signer.md`

Rename and move to `pending-changesets/` (while in progress) or leave
in `.changeset/` (when ready to release).

### Umbrella `@parity/product-sdk` policy

When any constituent package gets a **minor** bump in a release wave,
**list `@parity/product-sdk` (the umbrella) explicitly as a minor in
the changeset alongside the constituent**.

Without this, `@parity/product-sdk` only cascades at patch level
(controlled by `updateInternalDependencies: "patch"` in
`.changeset/config.json`) — and the umbrella ends up at a lower bump
than the child it re-exports. Prior waves (0.3.0 → 0.4.0, 0.4.0 →
0.5.0) have followed this policy; keep it consistent.

Example changeset header:

```md
---
"@parity/product-sdk": minor
"@parity/product-sdk-contracts": minor
---
```

## Promoting a pending changeset

When the PR that closes the work is ready:

```bash
git mv pending-changesets/<name>.md .changeset/<name>.md
```

Commit the move. Merging that PR to `main` triggers the release.

## Previewing what the next release will do

```bash
pnpm changeset status
```

Lists every package that will get bumped, at what level, including
transitive-dependency cascades. Run this before merging anything into
`.changeset/` so you can sanity-check the wave.

Example output:

```
Packages to be bumped at patch:
  - @parity/product-sdk-terminal
  - @parity/product-sdk-bulletin
  ...

Packages to be bumped at minor:
  - @parity/product-sdk
  - @parity/product-sdk-contracts
```

## What happens on push to main

The release workflow:

1. Runs `pnpm changeset version` — consumes every `.md` under
   `.changeset/`, bumps versions in each affected `package.json`,
   appends entries to each `CHANGELOG.md`, deletes the consumed
   changeset files.
2. Commits the version bumps as `chore: version packages`.
3. Builds every publishable package (`pnpm build`).
4. Creates per-package git tags (`@parity/product-sdk@0.5.0`, etc.).
5. Hands off to `paritytech/npm_publish_automation` to publish to npm.

If `.changeset/` is empty (after `README.md` is excluded), nothing
happens — no version bumps, no tags, no publish.

## Authoring a GitHub release description

The auto-generated changelog text in per-package `CHANGELOG.md` files
is comprehensive but per-package. For the GitHub release on the
umbrella version tag, write a consolidated description that:

- Leads with the headline change(s) for the wave.
- Groups bullet points by package.
- References PR numbers.
- Lists all bumped versions in a "Versions in this release" section.
- Includes a "Migration" section if anything is breaking.

Past release descriptions (linked from each GitHub release) are the
template — match their structure for consistency.

## Notes

- **No changeset = no release.** See [When does a PR need a
  changeset?](#when-does-a-pr-need-a-changeset) above. PRs that don't
  ship a changeset don't fire the release workflow.
- **Multiple changesets accumulate across PRs.** Each one runs through
  `pnpm changeset version` together at release time. Don't try to
  pre-merge or combine them on disk — the tool handles aggregation.
- **Highest bump type wins per package.** If two changesets both list
  `@parity/product-sdk-foo` (one `patch`, one `minor`), the resulting
  bump is `minor`.
- **Pre-release tags aren't currently used.** Every push to `main` with
  a changeset publishes a stable version.
