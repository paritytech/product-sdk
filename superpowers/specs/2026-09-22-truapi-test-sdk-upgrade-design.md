# Upgrading to the latest TrUAPI libraries

**Date:** 2026-09-22
**Status:** approved, ready for implementation planning
**Scope:** one phase — `@parity/truapi` `0.17.0 → 0.18.0` **and**
`@parity/host-api-test-sdk` `0.12.1 → 0.14.0`, together.

> **Revision note.** An earlier draft of this spec split the work in two,
> because the newest test SDK at the time (0.13.1) pinned `@parity/truapi`
> at exactly `0.17.0` and bundled a host core frozen on the 0.17.0 wire —
> so bumping truapi would have broken every e2e suite at handshake.
> `@parity/host-api-test-sdk@0.14.0`, published 2026-09-22 09:51 UTC,
> pins `@parity/truapi: 0.18.0` and resolves that. The split is gone, and
> so is the decision to skip `statement-store-demo`'s e2e: 0.14.0 restores
> the statement API that 0.13.1 had removed.

## What is being upgraded

| Package | Current | Target | Consumed by |
|---|---|---|---|
| `@parity/truapi` | 0.17.0 | **0.18.0** | `packages/host` (via catalog) |
| `@parity/host-api-test-sdk` | 0.12.1 | **0.14.0** | 9 × `examples/*` e2e (via catalog, `devDependencies`) |

`@parity/truapi-host` (0.18.0) and `@parity/truapi-provider` (0.2.1) also
exist. This repo depends on neither, and this work does not introduce them.

### Why the two must move together

The handshake is a strict equality check on the codec version
(`@parity/truapi/dist/client.js:291`), and 0.18.0 moves
`TRUAPI_CODEC_VERSION` from `2` to `3`. The test SDK bundles its host core as
WebAssembly rather than resolving it from `node_modules`, so the core's wire
schema is fixed at publish time and no pnpm `override` can move it.

Verified directly, since the declared dependency is not sufficient evidence
for a vendored core:

| Test SDK | Bundled `truapi_server_bg.wasm` schema hash | Wire |
|---|---|---|
| 0.13.1 | `50637d83426acd22` | truapi 0.17.0, codec 2 |
| **0.14.0** | **`462dacb6e0d1f504`** | **truapi 0.18.0, codec 3** |

So 0.14.0 is the first test SDK that can talk to a product on truapi 0.18.0,
and a product on truapi 0.17.0 can no longer talk to it. Bumping one without
the other breaks all nine e2e suites at handshake, in either direction.

## What actually changed upstream

Determined by diffing the published `.d.ts` of each version. Neither package
ships a CHANGELOG.

### `@parity/truapi` 0.17.0 → 0.18.0

At the type level this release is almost entirely **additive**:

- `CallOptions { signal?: AbortSignal }` as an optional trailing argument on
  every generated request method.
- `LocalStorageClient.subscribe` — per-key change subscription.
- A new `WorkerClient` (`beginOperation` / `endOperation`) on
  `TrUApiClient.worker`, plus `OperationId` and the `HostWorker*` /
  `HostWorkerOperationError` types.
- `MESSAGE_TYPE_CANCEL = 4` and the cancel leg of the wire protocol.
- A new `generated/internal.d.ts` (re-exports `./types.js`).

No exports, dependencies or entry points were removed. The `exports` map and
dependency set are byte-identical between the two versions.

Two consequences for this repo:

**A new `Cancelled` variant on `CallErrorValue`** (`scale.d.ts`). This breaks
any exhaustive `switch` over a call error. **There is none.**
`packages/host/src/errors.ts:74-101` (`formatHostError`) is tag-generic — it
matches `Domain`, then any `{ tag, value: { reason } }`, then falls through to
returning `error.tag` for unit variants. `Cancelled` renders as `"Cancelled"`
with no change. The only other call-error narrowing is an `=== "Unsupported"`
equality check at `packages/host/src/chain-discovery.ts:137`, which a new
variant cannot break. The `switch (… .tag)` sites in `papi-provider.ts`,
`individuality/*` and `terminal/host-cache.ts` are over unrelated unions.

**`TrUApiClient` gained a `worker` member**, so the fake client in
`packages/host/src/testing.ts` must model it or stop satisfying the interface.
This mirrors exactly what the 0.17.0 bump (`55a2320`) did for the then-new
`pocket` domain, and takes the same one-line form.

### `@parity/host-api-test-sdk` 0.12.1 → 0.14.0

Two releases of change. 0.13.0 migrated the test host off
`@novasamatech/host-api` onto `@parity/truapi` and rewrote the fixture
surface; 0.14.0 restored the statement API and followed truapi to 0.18.0.

**Removed in 0.13.x and still gone in 0.14.0:**

- `setPaymentBalance()`, `getPaymentLog()`, `clearPaymentLog()`,
  `setPaymentTopUpBehavior()`, `simulatePaymentStatus()` — the payment group.
- `setLoginBehavior()`, `getIsAuthenticated()`, `simulateDisconnect()`,
  `simulateReconnect()` — the login/connect group.
- `setEnforcePermissions()`.

This repo uses **none** of these. The payment, login and chat groups have zero
call sites, and `setEnforcePermissions` survives only in a comment at
`examples/signer-demo/e2e/permission.spec.ts:16`.

**Restored in 0.14.0, with new signatures** — this is the material change from
the previous draft:

| Method | 0.12.1 | 0.14.0 |
|---|---|---|
| `clearStatements()` | `void` | `void` — unchanged |
| `getSubmittedStatements()` | `StatementSubmissionLogEntry[]`, i.e. `{ statement: unknown, timestamp }` | `StatementEntry[]`, i.e. `{ topics: HexString[], data, proof, fromProduct, timestamp }` |
| `injectStatement(s)` | `(statement: unknown) => void`, taking a raw host-format statement | `(statement: StatementInput) => StatementEntry`, where `StatementInput` is `{ topics: HexString[], data?: HexString }` |

`injectStatement` is much simpler than it was: topics and data are `0x`-hex
strings rather than `Uint8Array`, and it no longer takes `expiry` or `proof` —
the host signs with the active session identity, because the core drops an
unproven statement. It is also now available both on the fixture and in-page
via `window.__TEST_HOST__`, and seeded statements are replayed to a
subscription opened later, so a test no longer has to win a race against the
product's subscribe.

0.14.0 also adds `getStatements()` (everything retained, product-submitted or
seeded) alongside `getSubmittedStatements()` (narrowed to `fromProduct`).

**Otherwise changed:**

- `productAccounts` keys move from `"<product>.dot/<index>"` to the bare
  `"<product>.dot"`. One entry now moves a product's whole account subtree
  rather than a single derivation index.
- `productId` is a new option. It remains **optional**, defaulting to
  `'test-product.dot'`, but the core refuses any product-account signing call
  whose `dotNsIdentifier` names a different product.
- `DevAccountInfo.uri` is no longer a polkadot-js SURI. It is split on `//`
  and each segment is a hard-junction label verbatim. A mnemonic or hex seed
  passed here is now read as a *label* and silently derives an unintended
  account. This repo passes only dev names, so it is unaffected.
- `accounts[0]` is now the active identity and **the only account that signs**.
- `switchAccount()` re-mints the host session but does **not** reload the
  product iframe and does not notify the product.
- `NetworkConfig` gains `chain?: ChainIdentifier`; a network omitting it is
  left out of `supportedChains()`. `PASEO_ASSET_HUB` now carries
  `chain: 'AssetHub'`, and the fixtures spread it, so this needs no change.
- `setPermissionBehavior` / `setUserConfirmationBehavior` now accept
  `FixtureConsentBehavior`, a **superset** of the old values that adds
  `'approve-once'`. Existing call sites are unaffected.

**Added and not adopted here:** `executionKind`, `initialState`, `behaviors`,
device-permission controls, locale controls, feature-support overrides,
chain-set overrides, product-storage seeding, `getConnectionStatus()` /
`getChainStatus()`, chat seeding, and the worker operation log
(`getOperationLog()`, `getOpenOperations()`, `clearOperationLog()`).

## Design

### Blast radius

`@parity/truapi` is consumed by `packages/host` via `catalog:`. Its only
required source change is the fake client's new `worker` member.

`@parity/host-api-test-sdk` is a `devDependency` of `examples/*` only. Nine
examples carry an e2e fixture:

| Example | Package name | dotNS id | Calls `getProductAccount`? |
|---|---|---|---|
| `chain-client-demo` | `@parity/product-sdk-chain-client-demo` | `chain-client-demo.dot` | no |
| `cloud-storage-demo` | `@parity/product-sdk-cloud-storage-demo` | `bulletin-demo.dot` | no |
| `contracts-demo` | `@parity/product-sdk-contracts-demo` | `contracts-demo.dot` | **yes** |
| `host-demo` | `@parity/product-sdk-host-demo` | `host-demo.dot` | no |
| `keys-demo` | `@parity/product-sdk-keys-demo` | `keys-demo.dot` | no |
| `signer-demo` | `@parity/product-sdk-signer-demo` | `signer-demo.dot` | **yes** |
| `statement-store-demo` | `@parity/product-sdk-statement-store-demo` | `statement-store-demo.dot` | no |
| `storage-demo` | `@parity/product-sdk-local-storage-demo` | `storage-demo.dot` | no |
| `tx-demo` | `@parity/product-sdk-tx-demo` | `tx-demo.dot` | **yes** |

Note that `storage-demo`'s directory name and package name differ.
`pvm-contracts-example` has no e2e fixture and is untouched.

### Workspace changes

In `product-sdk/pnpm-workspace.yaml`:

- `catalog."@parity/truapi"`: `^0.17.0` → `^0.18.0`
- `catalog."@parity/host-api-test-sdk"`: `^0.12.1` → `^0.14.0`
- `minimumReleaseAgeExclude`: both entries updated to `@parity/truapi@0.18.0`
  and `@parity/host-api-test-sdk@0.14.0`

Every consumer keeps its `"catalog:"` reference, so no `package.json` changes.

`pnpm-lock.yaml` changes as a result. The 0.12.1 entry goes, and with it
`@novasamatech/host-api@0.9.4` — the copy the test SDK pulled in.
`@novasamatech/host-api@0.10.0` **stays**: it is a transitive dependency of
`@novasamatech/host-papp@0.10.0`, which `packages/terminal` depends on. That
is a separate legacy stack, pinned exact for PAPI 2 reasons, and is not
touched here — along with `@novasamatech/statement-store`, `storage-adapter`
and `substrate-slot-sr25519-wasm`. So this upgrade does not remove
`@novasamatech/*` from the tree; it only stops `examples/*` contributing to it.

### Source change: the fake truapi client

`packages/host/src/testing.ts` exports `createFakeTruApiClient`, which
satisfies `TrUApiClient` by listing every domain. 0.18.0 adds `worker`, so it
gains one line alongside the other unmodeled domains:

```ts
worker: notModeled("worker"),
```

This is deliberately *unmodeled*, matching how `pocket` was handled in the
0.17.0 bump: the domain throws when touched. Modelling it is a feature, not
part of this upgrade.

### Fixture migration

Uniform across all nine `examples/*/e2e/fixtures.ts`:

1. Add `productId: "<id>.dot"`, using the same id that example's
   `productAccounts` key already names.
2. Re-key `productAccounts` from `{"<id>.dot/0": "bob"}` to
   `{"<id>.dot": "bob"}`.

`productId` is the change most likely to fail silently. It is strictly
load-bearing only for the three demos that call `getProductAccount`, and inert
for the other six, whose `productAccounts` entries are already vestigial. We
set it in all nine anyway: it is one line, it is uniform, and it stops the
next demo that starts signing from inheriting a silent failure.
`cloud-storage-demo` keeps its existing `bulletin-demo.dot` id — inert there,
and changing it is out of scope.

### statement-store-demo

Migrated, not skipped. All ten tests stay live. Three call sites change shape:

- **`clearStatements()`** (9 sites) — no change.
- **`getSubmittedStatements()`** (4 sites) — the entry shape changed. Three
  sites only read `.length` or `.timestamp` and are unaffected.
  `publish.spec.ts:92-96` reads `submitted[last].statement` as a raw host
  statement and asserts on `.topics`; `.statement` no longer exists. Topics
  are now on the entry directly and are `0x`-hex strings, not `Uint8Array`,
  so the assertion and its accompanying comment both need updating.
- **`injectStatement()`** (3 sites, all in `subscribe.spec.ts`, called in-page
  via `window.__TEST_HOST__`) — the argument shape changed substantially.
  Each call drops `expiry` and `proof` entirely, and passes hex strings rather
  than `Uint8Array`: `topics: [fromHex(topic)]` becomes `topics: [topic]`, and
  the `TextEncoder`-encoded JSON payload becomes a hex-encoded string.

This is the one part of the work with real judgement in it, and it is the part
to review most carefully.

### Risks

**`signer-demo/e2e/switch-account.spec.ts` may fail.** `switchAccount` now
re-mints the host session without reloading the iframe or notifying the
product, while `getConnectionStatus` drops to `'disconnected'` on a switch —
so nothing prompts a re-handshake and the test's `waitForAppReady` can hang.
The likely fix is an explicit reload after the switch. Confirm the real
failure before changing the test. If a reload does not fix it, skip that one
test under a tracked TODO rather than letting it block the upgrade — and say
so explicitly in the PR. Weakening the assertion until it passes is not an
acceptable resolution.

**Silent signing failures from a missed `productId`.** Mitigated by applying
it uniformly and by running each demo's e2e separately so failures are
attributable.

**`e2e/` is not typechecked by anything.** Every example's `tsconfig.json` is
`"include": ["src"]`, and Playwright transpiles without typechecking. So
neither `pnpm build` nor `pnpm check` validates a fixture or spec change — a
mistake surfaces only as a confusing timeout mid-Playwright-run. The
statement-store rewrite in particular is typo-prone. The implementation
therefore adds a throwaway per-demo `tsconfig.e2e.json` typecheck gate, run
before the slow suites.

### Explicitly out of scope

- **Restoring `signer-demo/e2e/permission.spec.ts` to its original intent.**
  That test was deliberately weakened because 0.12.1 exposed
  `setEnforcePermissions` without wiring it. The newer SDK appears to enforce
  permissions on signing, so the original revoke-then-sign assertion may now
  be expressible. That is a test improvement riding on a dependency bump; it
  gets its own follow-up.
- Surfacing `CallOptions.signal` through the SDK's own facades. Additive and
  optional — a feature, not part of the bump.
- Modelling the `worker` domain in the fake client beyond `notModeled`, or
  exposing `worker` / `localStorage.subscribe` from
  `packages/host/src/truapi.ts`.
- Adopting any newly added test-SDK surface.
- `@parity/truapi-host`, `@parity/truapi-provider`.
- The `@novasamatech/*` dependencies in `packages/terminal`.
- Changing `cloud-storage-demo`'s `bulletin-demo.dot` id to match its
  directory name.

### Verification

In order, from `product-sdk/`:

1. `pnpm install`
2. `pnpm -r build`
3. `pnpm -r test`
4. `pnpm check` (`pnpm format` only if `check` flags something)
5. The e2e typecheck gate
6. `pnpm --filter "<package name>" test:e2e` **per demo**, not the aggregate
   `pnpm test:e2e`, so a failure is attributable to one suite. Use the package
   names from the blast-radius table — they are not all derivable from the
   directory name.

Per CLAUDE.md, a darwin-local e2e failure is checked against CI before being
treated as real.

### Changeset

**Required**, unlike the earlier split-phase draft. The catalog entry for
`@parity/truapi` flows through a `catalog:` reference in `packages/host`,
which is published — one of `RELEASES.md`'s explicit "needs a changeset"
criteria. (The test-SDK entry alone would not have needed one; it reaches only
unpublished `examples/*`.)

Following the precedent set by the 0.17.0 bump in `55a2320`:

- Parked in `product-sdk/pending-changesets/`, **not** `.changeset/` — a
  separate `chore(release):` PR promotes it. CI enforces this with the
  `product-sdk: Changeset location` check.
- `"@parity/product-sdk-host": minor` and `"@parity/product-sdk": minor`. The
  umbrella must be listed explicitly or it cascades only at patch level.
- `minor` rather than `patch` because on 0.x that is how a breaking change is
  signalled. This package's own API is unchanged; the break is the wire codec,
  which means hosts must move in the same window.

The body should tell a consumer three things: pair with a truapi 0.18 host
(codec 2 → 3, schema `50637d83426acd22` → `462dacb6e0d1f504`); a new `worker`
domain exists on the client and is unmodeled in the fake; and call errors can
now carry a `Cancelled` variant.

## Open questions

None. The one genuine fork in the earlier draft — what to do about
`statement-store-demo`, whose e2e had lost its host API — was dissolved by
0.14.0 restoring that API. The tests are migrated rather than skipped, and no
tracking issue is needed.
