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
spec at `.claude/migrations/specs/` (project-local — typically gitignored
so the planning artifact does not get committed to the target repo).
After the spec is approved, it hands off to `writing-plans` which
produces an executable implementation plan in `.claude/migrations/plans/`.

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

- ❌ **Never edit code.** The skill's role is discovery + spec writing
  only. Code edits happen later in `executing-plans`.
- ❌ **Never skip a CHECKPOINT.** Both the decision matrix (Phase 2)
  and the spec (Phase 3) require explicit user approval before
  advancing.
- ❌ **Never resolve unrelated upstream regressions.** If you encounter
  pre-existing upstream bugs (broken transitive deps, framework
  regressions unrelated to the SDK), note them as out-of-scope in the
  spec body. Do not include them in the migration plan.
- ❌ **Never design key-rotation migrations** for HKDF info-string
  mismatches. Defer to a separate follow-up spec (see G3).
- ❌ **Never commit, open PRs, or create GitHub issues by default.**
  These are mode-gated: see **Launch modes** below. Default mode
  (`local`) does none of them.
- ✅ **Always run discovery first.** No "I already know what this
  repo needs" — every invocation inspects the actual target repo.

## Launch modes

By default the skill writes a local spec and does not commit or open
anything in the target repo. The user can opt into other modes by
stating intent at invocation. Three modes:

- **`local`** *(default)* — spec written to `.claude/migrations/specs/`,
  no commit, no issue. Use when planning before deciding.
- **`commit`** — spec written to `docs/migrations/specs/` (tracked
  path) AND committed with a single-line message (no co-author
  trailer). Triggered by user phrasing like "commit the spec",
  "committa la spec", "commit the migration plan".
- **`issue`** — spec content used as the body of a new GitHub issue
  via `gh issue create --title "Migrate to @parity/product-sdk" --body-file <spec-path>`. The spec is also written
  locally to `.claude/migrations/specs/` for reference. Triggered by
  phrasing like "open an issue", "apri un'issue", "create a migration
  issue". Requires `gh` authenticated for the target repo.

If the user's intent is ambiguous, ask once: "Mode? `local` (default,
no commit/issue), `commit` (commit the spec), or `issue` (open a GitHub
issue with the spec)?" Default to `local` if no answer.

Modes are **mutually exclusive** in the same invocation. To do both
"commit the spec" AND "open an issue", run the skill twice or ask the
user which to do first.

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

### Discovery report shape

The report is an in-memory object the skill carries into Phase 2.
Include at minimum:

- `framework`: one of `next` / `nuxt` / `vite` / `cli` / `mixed`
- `workspaceStructure`: `single-app` | `monorepo` with N workspaces
- `containerDetection`: `dual` | `container-only` | `standalone`
- `legacyStacks`: list of detected stacks with example files
- `papiVersion`: resolved version from lockfile
- `tests`: detected test runner + count

When the discovery report is complete, immediately proceed to Phase 2.

## Phase 2 — Decision matrix

For each of the 15 areas below, assign a **status** and pick a
**sub-pattern**. Status values:

- **yes** — apply this migration in scope
- **no** — not applicable to this product. Also the correct status when Phase 1 discovery surfaces no evidence of the area's legacy pattern. Do not assume the pattern is present "somewhere" — if grep did not find it, status is **no**.
- **deferred** — pattern IS present in the repo but the migration cannot be applied safely now (e.g., G3 HKDF info-string mismatch with persisted ciphertext). Record the reason in the spec's "Out of scope" section — do not create a separate follow-up spec.
- **optional** — simplification opportunity, not strictly required

### The 15 areas

| # | Area | Owning skill | In-scope when | Defer when |
|---|---|---|---|---|
| 1 | Bootstrap | `product-sdk-app-builder` | at least one other area is in-scope (**evaluate last** — depends on rows 2–15) | n/a |
| 2 | Chain access | `product-sdk-chain-connection` | `createClient` / `createPapiProvider` / `@polkadot-apps/chain-client` / `@novasamatech/product-sdk` present | target chain not supported by host |
| 3 | Wallet/Signer | `product-sdk-transactions` | `getAccountsProvider` ∨ hand-rolled wallet injection | demo/mock mode (keep custom adapter) |
| 4 | Crypto primitives | `product-sdk-utilities` | `tweetnacl` ∨ `@skiff-org/skiff-crypto` ∨ `crypto.subtle.digest` | n/a |
| 5 | Utils (hex/hashing/planck) | `product-sdk-utilities` | manual `padStart(2,'0')` hex ∨ manual planck formatting | n/a |
| 6 | Key management | `product-sdk-utilities` + `product-sdk-transactions` | local HKDF ∨ custom `deriveMasterKey`/`deriveDocumentKey` | HKDF info-string mismatch on existing on-chain entries (see G3) |
| 7 | Address utils | `product-sdk-utilities` | `ss58Encode`/`toGenericSs58`/`h160ToSs58`/`ss58ToH160` ∨ wrapper file | n/a |
| 8 | App storage | `product-sdk-utilities` | direct `localStorage` / `IndexedDB` ∨ `@parity/host-api` `StorageApi` | non-cross-environment persistence |
| 9 | Bulletin | `product-sdk-bulletin` | `helia` / `@polkadot-apps/bulletin` ∨ in-browser IPFS | product does not use Bulletin (`bulletin: false`) |
| 10 | Contracts | `product-sdk-contracts` | `@polkadot-api/sdk-ink` ∨ `createInkSdk` | signer-plumbing refactor still open |
| 11 | Logger | `product-sdk-utilities` | scattered `console.*` ∨ custom logger | n/a |
| 12 | Statement Store | `product-sdk-statement-store` | pub/sub pattern ∨ manual statement-store interaction | n/a |
| 13 | Identity / DotNS | (uses `@parity/product-sdk/identity` directly) | product resolves DotNS names | n/a — **optional** simplification |
| 14 | PAPI 2.x bump + descriptors | _(this skill)_ | `polkadot-api@^1.x` in lockfile | major version pinning by product policy |
| 15 | Deps + overrides | _(this skill)_ | at least one other area is in-scope | n/a |

### Sub-pattern selection per area

- **(1) Bootstrap** → `createApp({ name, bulletin: <env|false>, logLevel })` lazy singleton in `lib/app.ts` (or equivalent). If framework is React, **prefer `ProductSDKProvider` + `useWallet`/`useStorage`/`useChain`** from `@parity/product-sdk/react` over a manual singleton — flag as opportunity even when current code is React-based but rolled its own provider. `bulletin: false` is **required** when area 9 is out of scope (default opens an unnecessary WebSocket).
- **(2) Chain access** → preset path `getChainAPI('paseo')` (zero-config) vs BYOD `createChainClient({ chains, rpcs })`. For container apps, also route via `getHostProvider(genesisHash)` from `@parity/product-sdk-host` with a direct-WS fallback. Cache the chain client **per-chain** so a single failed chain doesn't bring down the others. Note: 'paseo' resolves to **Paseo Next v2** chains in current SDK (`@parity/product-sdk-chain-client@0.4.1+`, `@parity/product-sdk-host@0.2.2+`, `@parity/product-sdk-bulletin@0.4.0+`).
- **(3) Wallet / Signer** → `SignerManager` from `@parity/product-sdk-signer`. If Bulletin (9) is in scope, **also** call `app.wallet.connect()` + `app.wallet.selectAccount(addr)` after the existing connection flow so the App-bound signer is populated (gotcha G2).
- **(4) Crypto** → `@parity/product-sdk-crypto`: `aesGcmEncryptText`/`Decrypt`, `boxEncrypt`/`Decrypt`, `deriveKey`, `randomBytes`, `nacl` re-export.
- **(5) Utils** → `@parity/product-sdk-utils`: `bytesToHex`, `hexToBytes`, `utf8ToBytes`, `concatBytes`, `sha256`, `blake2b256`, `keccak256`, `formatPlanck`, `parseToPlanck`, `getBalance`. Prefer the leaf package over the `@parity/product-sdk/crypto` re-exports in new code.
- **(6) Key management** → `KeyManager.fromSignature(sig, addr, { salt })` + `deriveSymmetricKey('domain:'+id)`. **Verify byte-for-byte** against the legacy implementation before adopting `KeyManager.deriveKeypairs()` — SDK info strings are hardcoded (gotcha G3).
- **(7) Address** → inline `normalizeSs58`/`isValidSs58`/`toGenericSs58`/`ss58Encode`/`ss58Decode`/`ss58ToH160`/`h160ToSs58`/`accountIdBytes`/`accountIdFromBytes`/`truncateAddress`/`addressesEqual` from `@parity/product-sdk-address`. Delete any thin wrapper file.
- **(8) App storage** → `createKvStore()` from `@parity/product-sdk-storage`. Migrate direct `localStorage.{get,set,remove}Item` to the resulting `KvStore`.
- **(9) Bulletin** → drop Helia/IndexedDB stack. Three valid paths: (a) via App — `app.bulletin.upload(bytes)` / `fetch(cid)`; (b) standalone — `BulletinClient.create({ environment, signer })`. (c) host-sponsored — `getPreimageManager().submit(data)` from `@parity/product-sdk-host` (@^0.3.0+). Host signs end-to-end, no app-side signer wired; ≤ 2 MiB only (single preimage, no chunking). Bulletin can migrate independently of AuthProvider. For better UX, pair (c) with `requestResourceAllocation([{tag: 'BulletInAllowance'}])` (also in `@^0.3.0+`, typed wrapper from PR #82) to grant the allowance once via a single permission modal rather than re-prompting per submission. Decision: any file > 2 MiB in the product → (a) or (b) — both require an app-side signer source, so bulletin migrates alongside `AuthProvider` / `HostProvider.connect()` work. All files ≤ 2 MiB → (c) — smallest migration scope, bulletin flips independently. Use `.withWaitFor('finalized')` for reorg-safe semantics. Reconstruct block hash via `api.query.System.BlockHash.getValue(blockNumber)` when needed (gotcha G9).
- **(10) Contracts** → `createContract(runtime, address, abi)` for ad-hoc reads; `ContractManager` with `cdm.json` for full apps. Drop `@polkadot-api/sdk-ink` unless signer plumbing is non-trivial.
- **(11) Logger** → `configure({ level })` once at bootstrap. Wrap the existing `createLogger(prefix)` so app-level call sites don't change.
- **(12) Statement Store** → `StatementStoreClient` with `{ mode: 'host', accountId }` inside containers, `{ mode: 'local', signer }` standalone. Use `ChannelStore` for stable two-party streams.
- **(13) Identity / DotNS** → `resolveDotNs` / `reverseDotNs` from `@parity/product-sdk/identity` instead of writing the contract call by hand. Status: **no** when the product does not use DotNS at all (nothing to migrate); **optional** when the product already integrates DotNS via a hand-rolled contract call (simplification opportunity — the hand-rolled call still works; replacing it is a nice-to-have).
- **(14) PAPI 2.x + descriptors** → bump `polkadot-api` 1.x → ^2.x plus aligned subpackages (`substrate-bindings`, `substrate-client`, `observable-client`, `metadata-compatibility`, `polkadot-sdk-compat`, `sdk-ink`, `sdk-statement`, `utils`); replace `polkadot-api/ws-provider/web` → `polkadot-api/ws`; replace `Binary.fromBytes`/`.asHex()` with `Binary.toHex(uint8)` and raw `Uint8Array`; rewrite event watching to iterate `watch().{block,events[]}`; bump `.papi/descriptors/package.json` to match.
- **(15) Deps + overrides** → see the "Cross-cutting work → Dependencies and overrides" block in the Phase 3 spec template (below) for the canonical add/remove/override lists.

### Checkpoint

After populating the matrix, **stop and present it to the user**.
Format as a compact Markdown table with columns: `#`, `Area`,
`Status`, `Sub-pattern`, `Notes`. Example shape (rows shown are
illustrative — yours must reflect the actual repo):

```
| #  | Area              | Status   | Sub-pattern                                     | Notes                              |
|----|-------------------|----------|-------------------------------------------------|------------------------------------|
| 1  | Bootstrap         | yes      | createApp({ name: '<repo>', bulletin: false })  | Singleton in lib/app.ts            |
| 2  | Chain access      | yes      | getChainAPI('paseo') + getHostProvider fallback | dual; per-chain cache              |
| 4  | Crypto            | yes      | replace tweetnacl + skiff-adapter               |                                    |
| 6  | Key management    | deferred | KeyManager.fromSignature only                   | G3 — info-string mismatch persists |
| 8  | App storage       | no       |                                                 | sessionStorage only                |
| 13 | Identity / DotNS  | optional | resolveDotNs (hand-rolled call still works)     |                                    |
```

Wait for explicit user approval before advancing to Phase 3. Do not
proceed unprompted — even if every status looks obvious. Upon
approval, immediately begin Phase 3.

## Phase 3 — Spec writing

Write a per-repo migration spec. The output path depends on the
**launch mode** (see Launch modes above):

- **`local`** or **`issue`** mode →
  `.claude/migrations/specs/YYYY-MM-DD-migrate-<repo>-to-product-sdk-design.md`
- **`commit`** mode →
  `docs/migrations/specs/YYYY-MM-DD-migrate-<repo>-to-product-sdk-design.md`

Use today's date. If the directory doesn't exist, create it. For
`local` / `issue` modes, if `.claude/` is not already in the repo's
`.gitignore`, add `.claude/migrations/` to it before writing the spec
(planning artifact stays local). For `commit` mode, the `docs/`
location is intentional: the spec is tracked alongside other
documentation.

### Spec template

```markdown
# Migrate <repo-name> to @parity/product-sdk

## Target
- Repo: <repo-name>
- Target SDK version: @parity/product-sdk@^X.Y.Z
- Target polkadot-api version: ^2.x

## Discovery summary
- Framework: <next | nuxt | vite | cli | mixed>
- Container detection: <dual | container-only | standalone>
- Workspace structure: <single-app | monorepo (N workspaces)>
- Legacy stacks detected: <list with example files>
- Tests: <runner + counts>

## Migration areas
For each in-scope/deferred/optional area: status, sub-pattern,
files affected (with paths), owning SDK skill, notes.

### 1. Bootstrap                [yes]
- Sub-pattern: createApp({ name: '<repo>', bulletin: <env|false> })
- Files: lib/app.ts (new), N call-sites
- Owning skill: product-sdk-app-builder
- Notes: ...

[... one subsection per area from the matrix ...]

## Cross-cutting work
### PAPI 2.x bump + descriptors
- Bump polkadot-api 1.x → ^2.x plus aligned subpackages: [list]
- Import path migrations: ws-provider/web → ws (N files)
- Binary API: .asHex()/.fromBytes() → Binary.toHex(uint8) / raw Uint8Array
- Event watching: api.event.X.watch(filter) → watch().{block,events[]} + filter in subscriber
- .papi/descriptors/package.json bumped to <version>

### Dependencies and overrides
- Add: [list with versions]
- Remove (direct): [list]
- Remains transitive: @novasamatech/product-sdk (via @parity/product-sdk-host)
- pnpm.overrides (required):
    "@polkadot-api/json-rpc-provider": "^0.2.0"          # always; SDK monorepo root has this
    "@polkadot-api/json-rpc-provider-proxy": "^0.4.0"    # add if legacy 0.2.8 proxy is being hoisted
  Reason: isolated-install hoisting picks up 0.0.4 stub (empty "main") and
  0.2.8 proxy with legacy input() signature → "onReady is not a function"

## Cleanup
After all in-scope area swaps land and before final verification —
remove dead code, unused imports, and now-redundant glue. The agent
must do this explicitly; it does not emerge from the per-area work.

- [ ] Delete orphaned files: wrapper modules replaced by SDK inlines
      (e.g. `utils/address.ts`), hand-rolled adapters (e.g.
      `skiff-adapter.ts`), legacy IPFS / Helia glue, `wallet-signer.ts`
      stubs. Verify zero in-tree references via `git grep` before each
      deletion.
- [ ] Remove unused imports across all touched files (run the
      project's lint/format script and resolve every "unused import"
      warning, then re-run to confirm clean).
- [ ] Remove deps that became unused after the migration. For each
      candidate (e.g. `@polkadot-labs/hdkd-helpers`, `tweetnacl`,
      `@skiff-org/skiff-crypto`, `helia`, `@polkadot-api/sdk-ink`),
      confirm zero in-tree consumers with `pnpm why <pkg>` (or
      equivalent for npm / bun) before removing from `package.json`.
- [ ] Delete `TODO migrate later` / `FIXME` comments that the
      migration has now resolved.
- [ ] Remove commented-out legacy code kept "just in case" during the
      swap. If tests pass without it, delete it — git history is the
      backup.

## Verification plan
- [ ] typecheck clean across N workspaces
- [ ] lint clean
- [ ] tests: <X/X unit, Y/Y integration, Z/Z e2e>
- [ ] build green
- [ ] manual smoke: <golden-path scenarios specific to this product>

## Recommended ordering
Phases (each = independent commit-worthy chunk):
1. Deps + overrides (failure mode contained)
2. PAPI 2.x adapt (mechanical)
3. Address utils inline (low risk, deletions)
4. Crypto + utils swap (mechanical, byte-identical verifiable)
5. Logger swap (low risk)
6. Chain access (touches bootstrap)
7. Bootstrap + Signer (interlocked — must land together)
8. Bulletin / Storage / Contracts / Statement Store (depend on bootstrap+signer)
9. Cleanup (see Cleanup section — dead files, unused imports, unused deps)
10. Final verification (Verification plan checklist)

## Out of scope
[list of intentionally skipped concerns + reasons]
```

### Self-review checklist

After writing the spec, before the user-review checkpoint, verify:

1. **No placeholders**: search for `TBD` / `TODO` / `FIXME` / `???` and replace each.
2. **Internal consistency**: do the area subsections match what the
   decision matrix said? Same statuses, same sub-patterns?
3. **Scope check**: is this focused enough for one implementation
   plan, or does it need to be split (e.g., by workspace)?
4. **Ambiguity check**: can any sub-pattern be interpreted two ways?
   Pick one and make it explicit.

Fix issues inline. No need to re-review.

### Checkpoint

After the spec passes self-review, **ask the user to review it**:

> "Spec written and saved to `<path>`. Please review it and let me
> know if you want changes before I hand off to writing-plans."

Wait for explicit approval. If changes are requested, make them and
re-run the self-review. Once the user approves, immediately invoke
Phase 4.

## Phase 4 — Hand-off

Once the spec is approved by the user, perform mode-specific actions
then hand off to `writing-plans`.

### Mode-specific actions

- **`local`** *(default)*: nothing extra. Proceed to hand-off below.
- **`commit`**: stage and commit the spec file with a single-line
  message (no co-author trailer). Use:
  ```bash
  git add docs/migrations/specs/<spec-filename>
  git commit -m "docs(migrations): add @parity/product-sdk migration spec"
  ```
  Report the commit hash to the user. Do NOT push — the user pushes
  manually.
- **`issue`**: open a GitHub issue with the spec as the body:
  ```bash
  gh issue create \
    --title "Migrate to @parity/product-sdk" \
    --body-file .claude/migrations/specs/<spec-filename>
  ```
  Report the issue URL to the user. If `gh` is not authenticated for
  the target repo, stop and ask the user to authenticate before
  retrying (do not silently fall back to a different mode).

### Hand-off

1. Invoke `superpowers:writing-plans` with the spec path as input.
   Explicitly instruct writing-plans to save the implementation plan
   to `.claude/migrations/plans/YYYY-MM-DD-migrate-<repo>-to-product-sdk.md`
   — this overrides its default `docs/superpowers/plans/` location and
   keeps the plan project-local. (The plan is always local regardless
   of the spec's launch mode — it is a working artifact, not a
   deliverable.)
2. `writing-plans` produces the implementation plan at that path.
3. The user then picks an executor:
   - `superpowers:subagent-driven-development` (recommended), or
   - `superpowers:executing-plans`.

This skill ends here. Do not attempt to execute the plan yourself.

## Gotcha catalog

Eleven trap doors observed across three reference migrations. Full
catalog with cause/symptom/fix per gotcha: see `references/gotchas.md`.

Apply the fix when the symptom appears; reference the gotcha number
(G1–G11) from the spec when applicable. The most frequently relevant
are: G1 (JSON-RPC overrides, **always** required), G7 (`bulletin: false`
when Bulletin out of scope), G10 (descriptors bump).

## References

For "how to use package X" content, the spec should point the reader
at the corresponding SDK skill (listed in the intro above) rather than
restating the API.

Hand-off target:

- `superpowers:writing-plans` — Phase 4 hand-off
