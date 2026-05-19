# Pending Changesets

A staging area for changesets that document changes which **aren't ready
to publish yet**. Move them into `.changeset/` only on the PR that
closes out the work they describe.

## Why this directory exists separately from `.changeset/`

`.github/workflows/product-sdk-release.yml` triggers a release on any
push to `main` that contains at least one changeset file under
`.changeset/`. The release pipeline:

1. Runs `pnpm changeset version` (consumes every changeset, bumps every
   listed package).
2. Builds, packs, and publishes to npm.

Once a changeset is under `.changeset/` and lands on `main`, the next
release wave will pick it up. There is no "draft" or "do not release"
flag on the changeset file format itself — presence inside
`.changeset/` is the trigger.

That makes `.changeset/` the wrong place to stage work-in-progress
release notes. If a teammate authors a changeset on a feature branch
they'll be iterating on for a few days, parking it under
`.changeset/` means the moment any *unrelated* PR merges to `main`,
their unfinished work gets published. This directory exists so that
doesn't happen.

## Why not just nest a subdirectory under `.changeset/`?

`@changesets/cli` reads `.changeset/` with two parallel rules
([source](../../node_modules/@changesets/read/dist/changesets-read.cjs.js)):

1. **Top-level `.md` files**: anything that doesn't start with `.`,
   ends in `.md`, and isn't `README.md` (case-insensitive) is parsed
   as a changeset.
2. **Subdirectories**: every subdirectory of `.changeset/` is treated
   as a **legacy v1 changeset** and the tool tries to read
   `changes.md` / `changes.json` from inside it. Missing those files
   produces warnings; present-but-malformed produces errors.

There's no safe path under `.changeset/` to park anything except
non-`.md` files or `README.md`. Hence: a sibling directory.

## Workflow

**Authoring a changeset for in-progress work:**

```bash
# From the product-sdk/ directory:
pnpm changeset
# Answer the prompts; this drops a generated file in `.changeset/`.
# Then move it here:
mv .changeset/<generated-name>.md pending-changesets/<descriptive-name>.md
```

Pick a descriptive name (kebab-case, summarizes the change) — the
generated names like `funny-rabbits-paint.md` aren't memorable for
review. Examples that worked well in past waves:

- `paseo-next-v2-swap.md`
- `expose-query-failure-value.md`
- `host-request-resource-allocation.md`
- `terminal-papi-native-signer.md`

**Promoting to release on the closing PR:**

```bash
mv pending-changesets/<name>.md .changeset/<name>.md
```

Stage that move in the same PR that closes the underlying work. When
the PR merges to `main`, the release workflow picks up the changeset
and publishes the wave.

**Check what the next release will look like:**

```bash
pnpm changeset status
```

Lists every package the staged changesets will bump and at what level
(patch / minor / major), including transitive-dependency cascades.

## Changeset format

Every file is a `.md` with a YAML frontmatter header naming the
packages and the bump level for each:

```md
---
"@parity/product-sdk-foo": minor
"@parity/product-sdk-bar": patch
---

**One-sentence summary.**

Body describing what changed, breaking changes (if any), and migration
notes. Renders as-is into the per-package `CHANGELOG.md` on the next
release.
```

### Bump-level conventions used in this repo

- `patch` — bug fix; no public-API change.
- `minor` — new public API surface; or, under pre-1.0 semver, breaking
  changes (since major is still `0`). Most of our packages are pre-1.0.
- `major` — reserved for post-1.0 breaking changes.

### Umbrella `@parity/product-sdk` policy

When any constituent package gets a minor bump in a release wave,
**list the umbrella `@parity/product-sdk` package explicitly as a
minor in the changeset** alongside the constituent. Otherwise it
cascades only at patch level (controlled by `updateInternalDependencies:
"patch"` in `.changeset/config.json`) and the umbrella ends up at an
oddly lower bump than its child. Prior waves (0.3.0 → 0.4.0,
0.4.0 → 0.5.0) followed this policy.
