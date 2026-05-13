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
