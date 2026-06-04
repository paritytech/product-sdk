# Updating `@parity/product-sdk-descriptors`

## When you'd update

The bundled descriptors snapshot the metadata of each supported chain at the
time of last release. Two common reasons to regenerate them:

1. **A chain's runtime upgraded** and the bundled bindings now error with
   `Incompatible runtime entry …` or silently mis-decode a storage entry.
2. **The default RPC is unreachable or rate-limited** in your environment and
   you need to point regeneration at your own endpoint.

`pnpm regenerate` handles both.

## Setup

One-time, from the repo root:

```bash
# Install workspace dependencies (gives you papi, pnpm filters, etc.)
cd product-sdk
pnpm install
```

You'll need Node 22+ (`node --version`) and pnpm 10+ (`pnpm --version`).

## Full Paseo refresh — end-to-end

This is the common case: refresh all three Paseo chains
(`paseo-asset-hub`, `paseo-bulletin`, `paseo-individuality`) against your own
RPCs because the public Paseo Next endpoints are flaky or rate-limited.

From `product-sdk/packages/descriptors/`:

```bash
# 1. See what's available (sanity check).
pnpm regenerate --list

# 2. Regenerate all three Paseo chains in one run.
#    Substitute the wss:// URLs with your team's RPCs.
pnpm regenerate \
  --chain paseo-asset-hub    --rpc wss://your-rpc.example/paseo-asset-hub \
  --chain paseo-bulletin     --rpc wss://your-rpc.example/paseo-bulletin \
  --chain paseo-individuality --rpc wss://your-rpc.example/paseo-people

# 3. Verify only the expected files changed.
cd ../../../ # back to repo root
git status product-sdk/packages/descriptors/
# Expected:
#   modified: product-sdk/packages/descriptors/.papi/metadata/paseo_asset_hub.scale
#   modified: product-sdk/packages/descriptors/.papi/metadata/paseo_bulletin.scale
#   modified: product-sdk/packages/descriptors/.papi/metadata/paseo_individuality.scale
#   modified: product-sdk/packages/descriptors/chains/paseo-asset-hub/.papi/polkadot-api.json
#   modified: product-sdk/packages/descriptors/chains/paseo-bulletin/.papi/polkadot-api.json
#   modified: product-sdk/packages/descriptors/chains/paseo-individuality/.papi/polkadot-api.json
# (the `polkadot-api.json` files will only show a codeHash / genesis diff —
#  the wsUrl override was restored automatically.)

# 4. Build and run the package tests against the new bindings.
cd product-sdk
pnpm --filter "@parity/product-sdk-descriptors" build
pnpm --filter "@parity/product-sdk-chain-client" test
```

If step 4 passes, you're ready to commit and open a PR (see below).

If the script printed a **genesis-drift warning**, stop — your RPC is serving
a different chain than the bundled descriptor expects. Double-check the URL
before continuing; shipping a regenerated descriptor that points at the wrong
chain will break every consumer.

## How the script behaves

Behind the scenes `pnpm regenerate`:

1. Rewrites each chain's `chains/<name>/.papi/polkadot-api.json` to set
   `wsUrl: <your-rpc>` (and drops the well-known `chain:` field if present).
2. Runs `papi update` against that RPC, which fetches fresh metadata, rewrites
   `.papi/metadata/<chain>.scale`, and regenerates the TypeScript bindings
   under `chains/<chain>/generated/dist/`.
3. **Restores** the original `polkadot-api.json` on exit so your committed
   config keeps pointing at the public RPC — consumers without your private
   endpoint can still use the package.

The metadata `.scale` blob and the `codeHash` / `genesis` in `polkadot-api.json`
are what actually get committed and shipped. The `wsUrl` override is a
local-run-only mechanism that the script cleans up after itself.

Pass `--keep` if you want the `wsUrl` override to stick — useful for
back-to-back dev runs against a local node, but **not** what you want for
a release PR.

## Submitting your regeneration as a PR

> Repo URL: **`<TODO: fill in once the public repo URL is fixed>`**

1. **Branch.** Use a descriptive name:

   ```bash
   git checkout -b chore/descriptors/paseo-refresh
   ```

2. **Stage only the regenerated artefacts.** The committed bits are the
   metadata blobs and the per-chain configs:

   ```bash
   git add \
     product-sdk/packages/descriptors/.papi/metadata/paseo_asset_hub.scale \
     product-sdk/packages/descriptors/.papi/metadata/paseo_bulletin.scale \
     product-sdk/packages/descriptors/.papi/metadata/paseo_individuality.scale \
     product-sdk/packages/descriptors/chains/paseo-asset-hub/.papi/polkadot-api.json \
     product-sdk/packages/descriptors/chains/paseo-bulletin/.papi/polkadot-api.json \
     product-sdk/packages/descriptors/chains/paseo-individuality/.papi/polkadot-api.json
   ```

   The generated `chains/<chain>/generated/` output is gitignored — it gets
   rebuilt from the committed metadata at publish time.

3. **Add a changeset** so the next release bumps the descriptors package:

   ```bash
   cd product-sdk && pnpm changeset
   ```

   - Pick `@parity/product-sdk-descriptors`.
   - **`patch`** for a routine metadata refresh that doesn't change the
     decode shape. **`minor`** if a runtime upgrade added new pallets or
     changed an existing storage / call shape (i.e. consumers may have to
     update code).
   - Summary, e.g. "refresh paseo-asset-hub, paseo-bulletin,
     paseo-individuality after runtime upgrade".

4. **Commit and push:**

   ```bash
   git commit -m "chore(descriptors): refresh paseo-asset-hub, paseo-bulletin, paseo-individuality"
   git push -u origin chore/descriptors/paseo-refresh
   ```

5. **Open a PR** against `main`. A maintainer will run E2E against the
   regenerated bindings before merging — a drift refresh occasionally hides a
   real consumer-side break (e.g. a pallet rename).

6. **Linked issue.** If you're refreshing in response to a tracked drift
   issue (`descriptors-drift` label), link it in the PR description so the
   tracking issue can be auto-closed on merge.

## Single-chain refresh

If you only need to regenerate one chain:

```bash
pnpm regenerate --chain paseo-asset-hub --rpc wss://your-rpc.example/
```

Stage and PR the corresponding two files
(`.papi/metadata/<chain>.scale` and
`chains/<chain>/.papi/polkadot-api.json`); the rest of the workflow is
identical.

## Smaller contributions

- **Doc fixes** in this file or the package README: open a PR directly,
  no changeset needed.
- **Adding a new chain** is a bigger change — see the descriptors README for
  the chain-onboarding checklist before opening the PR.
