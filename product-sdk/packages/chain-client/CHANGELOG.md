# @parity/product-sdk-chain-client

## 0.12.2

### Patch Changes

- Updated dependencies [d0260a1]
- Updated dependencies [d0260a1]
- Updated dependencies [d0260a1]
  - @parity/product-sdk-host@0.19.0

## 0.12.1

### Patch Changes

- Updated dependencies [84134e0]
- Updated dependencies [84134e0]
  - @parity/product-sdk-host@0.18.0

## 0.12.0

### Minor Changes

- 46e3592: **Re-add `previewnet` as a first-class environment.**

  Previewnet was dropped when its identity endpoints weren't secured for public use and its runtime matched paseo. Both have changed: the endpoints are secured, and previewnet now runs a Paseo runtime kept a step ahead of paseo-next-v2 (asset-hub `2000039` vs `2000036`, individuality `1000036` vs `1000032`), so products can build against upcoming runtime changes weeks early.

  - `@parity/product-sdk-descriptors` re-adds the `./previewnet-asset-hub`, `./previewnet-bulletin`, and `./previewnet-individuality` subpath exports, generated fresh against the live endpoints with real (non-zero) `codeHash` values so previewnet is covered by descriptor-drift detection like every other chain.
  - `@parity/product-sdk-chain-client` re-adds `"previewnet"` to the `Environment` union; `getChainAPI("previewnet")` resolves again, routing to the `previewnet.substrate.dev` endpoints for asset-hub, bulletin, and people (individuality).
  - `@parity/product-sdk-cloud-storage` re-adds the `previewnet` entry to `CloudStorageNetworks`.
  - `@parity/product-sdk-host` re-adds `BULLETIN_RPCS.previewnet`.

  Consumers on paseo or a production environment are unaffected; this is purely additive.

### Patch Changes

- 46e3592: **Say that createChainClient depends on the host, and correct two stale docs.**

  `createChainClient` accepts any PAPI descriptor, but every connection goes through the host provider keyed by that descriptor's genesis, with no WebSocket fallback. A chain is therefore reachable only if the active host routes it, which the package docs did not say while offering the path for "custom or pre-release chains". They now say it, and point at `isChainSupported` from `@parity/product-sdk-host` for checking before connecting. See #94 and #102 for the missing standalone path.

  Also removes a dead `Environment` union in `chain-client`'s `types.ts` that listed "local" and "westend", neither of which exists. Nothing imported it and the package exports only its root entry, so no consumer saw it.

  Also corrects the Previewnet DotNS TLD in two `identity/` comments, from `.dot` to `.test`, matching `dotns-abis.ts` which records verification on both networks.

  Docs, comments, and one unreachable type. No behaviour change.

- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
  - @parity/product-sdk-host@0.17.0
  - @parity/product-sdk-descriptors@0.11.0

## 0.11.0

### Minor Changes

- 3655724: Consume TrUAPI host chain discovery. `@parity/product-sdk-host`
  gains `getHostChainInfo()`, a cached facade over `chain.getChainInfo()` that
  resolves chain roles (`AssetHub`, `Bulletin`, `People`, …) to genesis hashes
  and returns `null` on hosts predating discovery. `getChainAPI()` can now be
  called with no argument to derive the environment from the host by matching
  the discovered asset hub genesis against the bundled descriptors; an explicit
  environment is validated the same way, failing with the new `EnvironmentMismatchError` /
  `GenesisMismatchError` instead of an opaque unsupported-genesis error. Only the
  asset hub is fatal there, since it anchors the environment; a bulletin or
  individuality descriptor that disagrees warns and leaves that one chain
  throwing on use, as any chain the host cannot serve already does. Calls
  that pass an environment keep exactly the previous behavior on legacy hosts;
  the zero-arg form needs discovery, so it throws there and outside a container.
  `createFakeTruApiClient` / `createFakeHost` model `chain.getChainInfo` behind a
  new `chainInfo` option, so tests can drive discovery; omitting it models a host
  predating the call. The `chain.getChainInfo` binding this rides on ships in
  `@parity/truapi` 0.9.0, adopted separately.

  The explicit form is only unchanged on legacy hosts. On a host that serves discovery,
  `getChainAPI("paseo")` can now fail where it previously connected:
  `EnvironmentMismatchError` when the host's asset hub genesis matches a different bundled
  environment, and `GenesisMismatchError` when it matches none and the bundled asset hub
  descriptor disagrees with the host. Both surface at the call rather than at the first
  storage read, so an unchanged call site fails earlier and with a different error type.

### Patch Changes

- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
  - @parity/product-sdk-host@0.16.0
  - @parity/product-sdk-descriptors@0.10.0

## 0.10.0

### Minor Changes

- 5ccab21: **Regenerate `paseo-bulletin` descriptors for the upcoming `v0.0.22-paseo` runtime (spec `1_000_022`).**

  Metadata was extracted offline from the `polkadot-bulletin-chain` `v0.0.22-paseo` release wasm (`papi add --wasm`) ahead of its deployment to Paseo Next v2, which currently runs spec `1_000_021`. Merge/publish this once the runtime upgrade is enacted on-chain.

  Runtime changes surfaced in the descriptors:

  - New `DataRenewal` pallet (`pallet_bulletin_data_renewal`, pallet index 42) — new tx/query/event API surface, hence the minor bump.
  - `renew`, `force_renew`, `enable_auto_renew` and `disable_auto_renew` **move off `TransactionStorage`** onto the new pallet. `CloudStorageClient.renew()` builds the old call via `@parity/bulletin-sdk`, so it will throw until that package is repointed at `DataRenewal.renew`.

  The pinned `codeHash` is pre-set to the release blob's blake2-256 (`0xabb9c076…`, matching what on-chain `:code` will hash to after the upgrade); `genesis` is unchanged.

### Patch Changes

- Updated dependencies [5ccab21]
  - @parity/product-sdk-descriptors@0.9.0

## 0.9.3

### Patch Changes

- Updated dependencies [70c30f3]
  - @parity/product-sdk-host@0.15.1

## 0.9.2

### Patch Changes

- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
  - @parity/product-sdk-host@0.15.0

## 0.9.1

### Patch Changes

- Updated dependencies [8ab88ba]
  - @parity/product-sdk-host@0.14.1

## 0.9.0

### Minor Changes

- c3fccfa: **Breaking: remove the Summit Network (Web3 Summit) environment.**

  The Summit event is over and its chains are being decommissioned. Removes
  the `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
  descriptors, `"summit"` from `Environment` / `CloudStorageEnvironment`
  (`getChainAPI("summit")` and `CloudStorageClient.create({ environment:
"summit" })` no longer compile), the `CloudStorageNetworks.summit` preset,
  and `BULLETIN_RPCS.summit`. `paseo` and `devnet` are unaffected.

### Patch Changes

- Updated dependencies [c3fccfa]
- Updated dependencies [c3fccfa]
- Updated dependencies [c3fccfa]
  - @parity/product-sdk-descriptors@0.8.0
  - @parity/product-sdk-host@0.14.0

## 0.8.0

### Minor Changes

- cb0098f: **Add `devnet` — the public Paseo-testnet products devnet — as a new environment.**

  Adds `devnet-asset-hub`, `devnet-bulletin`, and `devnet-individuality` (the
  People chain) descriptors, generated against the community-run Paseo system
  chains (Asset Hub 1000, People 1004, Bulletin 1010), and wires `devnet`
  through the host Bulletin RPC list, the cloud-storage network preset, and
  `getChainAPI("devnet")`. Unlike `paseo` — which targets the Paseo Next v2
  deployment — `devnet` targets the long-lived public Paseo testnet. Purely
  additive — no existing environment, descriptor, or endpoint changes.

### Patch Changes

- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
  - @parity/product-sdk-descriptors@0.7.0
  - @parity/product-sdk-host@0.13.0

## 0.7.7

### Patch Changes

- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
  - @parity/product-sdk-host@0.12.0

## 0.7.6

### Patch Changes

- Updated dependencies [ef14a41]
  - @parity/product-sdk-host@0.11.0

## 0.7.5

### Patch Changes

- 8dd1232: chore(deps): bump polkadot-api to 2.1.6

  Updates the `polkadot-api` catalog entry `^2.1.5` → `^2.1.6` (2.1.6 carries the
  double-notification fix). Every published package resolves `polkadot-api`
  through `catalog:`, so each one's published `dependencies` range moves to
  `^2.1.6`. There is no source change in any package — these are patch bumps to
  ship the new floor via the published `catalog:` resolution.

  Releases the catalog bump from #223, which was merged to `main` without a
  changeset.

- Updated dependencies [8dd1232]
  - @parity/product-sdk-descriptors@0.6.2
  - @parity/product-sdk-host@0.10.3

## 0.7.4

### Patch Changes

- Updated dependencies [c39332e]
  - @parity/product-sdk-host@0.10.2

## 0.7.3

### Patch Changes

- Updated dependencies [9ce5ab2]
  - @parity/product-sdk-host@0.10.1

## 0.7.2

### Patch Changes

- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
  - @parity/product-sdk-host@0.10.0

## 0.7.1

### Patch Changes

- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
  - @parity/product-sdk-host@0.9.0
  - @parity/product-sdk-descriptors@0.6.1

## 0.7.0

### Minor Changes

- a2fd276: **Add the Summit Network (Web3 Summit) as a new environment.**

  Adds `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
  (the People chain) descriptors, and wires `summit` through the host
  Bulletin RPC list, the cloud-storage network preset, and
  `getChainAPI("summit")`. Purely additive — no existing environment,
  descriptor, or endpoint changes.

### Patch Changes

- Updated dependencies [a2fd276]
- Updated dependencies [a2fd276]
  - @parity/product-sdk-descriptors@0.6.0
  - @parity/product-sdk-host@0.8.0

## 0.6.1

### Patch Changes

- Updated dependencies [d4bc935]
  - @parity/product-sdk-host@0.7.1

## 0.6.0

### Minor Changes

- f6bdaaf: **Remove the unused `rpcs` field from `ChainClientConfig`.**

  `createChainClient` routed every connection through the host provider, so
  the `rpcs` endpoints were never read at runtime — the field only forced
  callers to construct and pass a no-op argument. It has been removed, and
  `createChainClient({ chains })` is now the full config shape. The internal
  preset RPC table and the dead `getChainAPI` wiring that fed it were dropped
  as well.

  **Breaking:** callers that passed `rpcs: {...}` will hit a TypeScript
  excess-property error and must delete that key. There is no runtime behavior
  change — the field carried no effect.

  ```diff
   const client = await createChainClient({
       chains: { assetHub: paseo_asset_hub },
  -    rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
   });
  ```

- f6bdaaf: **Surface a catchable error when the host doesn't support a chain, instead of hanging forever.**

  Previously, connecting to a chain the host doesn't recognize (e.g. not enabled
  in the current Desktop/Browser build, or a descriptor genesis hash that drifted
  after a network reset) produced a provider whose JSON-RPC requests were silently
  dropped. Every query against that chain then awaited indefinitely — no rejection,
  no error, no built-in timeout.

  `getHostProvider` now verifies host support (via the same `host_feature_supported`
  check the wrapper performs internally) _before_ handing a provider to PAPI, and
  throws the new `ChainNotSupportedError` (carrying the offending `genesisHash`) when
  the host can't serve the chain.

  `createChainClient` degrades per-chain rather than all-or-nothing: supported chains
  in the same call stay fully usable, and an unsupported chain's API throws
  `ChainNotSupportedError` on first use (e.g. `client.assetHub.query…`) instead of
  hanging. This matches the reported behaviour where one chain (Bulletin) keeps
  working while another is unavailable. A hard failure (e.g. not running inside a
  container) still rejects the whole call as before.

  ```ts
  import {
    createChainClient,
    ChainNotSupportedError,
  } from "@parity/product-sdk-chain-client";

  const client = await createChainClient({
    chains: { assetHub: paseo_asset_hub, bulletin: paseo_bulletin },
  });

  try {
    await client.assetHub.query.System.Number.getValue();
  } catch (err) {
    if (err instanceof ChainNotSupportedError) {
      // err.genesisHash — the chain the host refused
    }
  }

  // Other chains in the same client are unaffected:
  await client.bulletin.query.TransactionStorage.ByteFee.getValue();
  ```

  `ChainNotSupportedError` is exported from both `@parity/product-sdk-host` and
  `@parity/product-sdk-chain-client`. Connecting outside a host container still
  returns `null` / throws the existing "host provider unavailable" error.

### Patch Changes

- Updated dependencies [f6bdaaf]
  - @parity/product-sdk-host@0.7.0

## 0.5.3

### Patch Changes

- dc3a452: Bump shared catalog dependencies to their latest within range. Dependency-range updates only; no public API changes:

  - `polkadot-api` `^2.1.2` → `^2.1.5` (all packages listed)
  - `@polkadot-labs/hdkd-helpers` `^0.0.27` → `^0.0.30` (contracts, keys, tx)
  - `viem` `^2.46.2` → `^2.52.0` (contracts)
  - `@novasamatech/host-api` & `@novasamatech/host-api-wrapper` `^0.8.0` → `^0.8.3` (signer's optional deps; host/statement-store carry them as dev-only/unchanged peers)

- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
  - @parity/product-sdk-host@0.6.1
  - @parity/product-sdk-descriptors@0.5.2

## 0.5.2

### Patch Changes

- Updated dependencies [551c1bb]
  - @parity/product-sdk-host@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [30b798f]
  - @parity/product-sdk-descriptors@0.5.1

## 0.5.0

### Minor Changes

- 7610e61: ### `@parity/product-sdk-host`

  - New wrappers: `getChatManager`, `getThemeProvider`, `deriveEntropy`, `requestPermission`, `requestDevicePermission`.
  - New container helpers: `createHostLocalStorage`.
  - New TruAPI re-exports: `createHostPreimageManager`, `formatHostError`.
  - New type re-exports: `ProductAccountId`, `SignedStatement`, `Statement`, `Topic`, `ChatManager`, `ChatMessageContent`, `ChatReceivedAction`, `ChatRoom`, `ChatRoomRegistrationResult`, `ChatBotRegistrationResult`, `ChatCustomMessageRenderer`, `ChatCustomMessageRendererParams`, `ThemeMode`, `ThemeProvider`, `DevicePermissionKind`, `RemotePermissionItem`.

  ### `@parity/product-sdk-chain-client`

  - New exports: `WellKnownChain` constant + `WellKnownChainHash` type for canonical genesis-hash lookups.

  ### `@parity/product-sdk-local-storage`

  - Widened the typed KV interface to match the upstream Novasama surface: `readBytes` / `writeBytes` methods and keyed `clear(key)`. Test mocks updated accordingly.

  ### Umbrella

  - `@parity/product-sdk`: minor cascade per `RELEASES.md` — any constituent minor bump cascades the umbrella.

  No consumer-facing source-compat breaks: all changes are additive expansions of public exports.

- 7610e61: **Drop previewnet support.**

  Previewnet is no longer used. Removed across the workspace:

  - `@parity/product-sdk-descriptors` drops the `./previewnet-asset-hub`, `./previewnet-bulletin`, and `./previewnet-individuality` subpath exports.
  - `@parity/product-sdk-chain-client` removes `"previewnet"` from the `Environment` union; `getChainAPI("previewnet")` no longer compiles or resolves.
  - `@parity/product-sdk-cloud-storage` removes the `previewnet` entry from `CloudStorageNetworks`.
  - `@parity/product-sdk-host` removes `BULLETIN_RPCS.previewnet`.

  ### Migration

  Consumers using paseo (testnet) or one of the production environments are unaffected. Anyone importing a `previewnet-*` descriptor or referencing `Environment === "previewnet"` should drop the references — the underlying runtime is shared with paseo, so paseo is the direct replacement for testing.

  Pre-1.0 breaking change per `RELEASES.md`; ships as `minor`.

### Patch Changes

- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
  - @parity/product-sdk-host@0.5.0
  - @parity/product-sdk-descriptors@0.5.0

## 0.4.2

### Patch Changes

- Updated dependencies [4c13257]
- Updated dependencies [4c13257]
  - @parity/product-sdk-descriptors@0.4.1
  - @parity/product-sdk-host@0.4.0

## 0.4.1

### Patch Changes

- Updated dependencies [bdeb144]
  - @parity/product-sdk-host@0.3.0

## 0.4.0

### Minor Changes

- 1cc3790: **Migrate the `paseo` preset to Paseo Next v2 endpoints and chain instances.**

  Paseo Next v1 is being shut down on 2026-05-20. Per the Paseo team, v2 is the successor — not a parallel network — so the `"paseo"` preset string keeps its name and now points at v2 chains. Consumers calling `getChainAPI("paseo")` get v2 with no code change.

  ### What changed

  - **`@parity/product-sdk-chain-client`**: `rpcs.paseo` swaps to the new endpoints (asset-hub-next, bulletin-next, people-next-system). The retired v1 mirrors (`sys.ibp.network/asset-hub-paseo`, `asset-hub-paseo-rpc.n.dwellir.com`, `paseo-bulletin-rpc.polkadot.io`, `paseo-people-next-rpc.polkadot.io`) are gone.
  - **`@parity/product-sdk-descriptors`**: every paseo subpackage (`paseo-asset-hub`, `paseo-bulletin`, `paseo-individuality`) regenerated against the live v2 RPC. Each descriptor's embedded `genesis` and `codeHash` reflect the v2 chain instance.
  - **`@parity/product-sdk-bulletin`**: `BulletinChain.paseo.genesisHash` literal updated to the v2 bulletin genesis.
  - **`@parity/product-sdk-host`**: `BULLETIN_RPCS.paseo` updated; `DEFAULT_BULLETIN_ENDPOINT` follows since it's `BULLETIN_RPCS.paseo[0]`.

  ### New endpoints

  | Chain                     | URL                                              | Genesis                                                              |
  | ------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
  | Asset Hub Next (1500)     | `wss://paseo-asset-hub-next-rpc.polkadot.io`     | `0x173cea9df45656cf612c8b8ece56e04e9a693c69cfaac47d3628dae735067af8` |
  | Bulletin Next (1501)      | `wss://paseo-bulletin-next-rpc.polkadot.io`      | `0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22` |
  | People Next System (1502) | `wss://paseo-people-next-system-rpc.polkadot.io` | `0x053e1a785bb0990b98768124d9609e963d9ca3558f5ac6e90a4297aaa0a0bd4b` |

  ### Breaking changes

  - Consumers that hardcoded any of the retired v1 RPC URLs must update them.
  - Consumers comparing genesis hashes (e.g. for chain-identity cache keys) will see different values for paseo asset-hub, bulletin, and individuality. The `paseo_asset_hub`, `paseo_bulletin`, and `paseo_individuality` descriptor objects each carry a new `.genesis` value, and `BulletinChain.paseo.genesisHash` is updated.
  - The `paseo-asset-hub` descriptor config switched from polkadot-api chain-spec resolution (`"chain": "paseo_asset_hub"`) to `wsUrl`-based resolution, since the chain spec registry doesn't yet know about v2. No consumer-visible impact — the resulting descriptor module exports the same `paseo_asset_hub` symbol with the same shape.

### Patch Changes

- Updated dependencies [1cc3790]
  - @parity/product-sdk-descriptors@0.4.0
  - @parity/product-sdk-host@0.2.2

## 0.3.0

### Minor Changes

- 5d81610: **Add previewnet environment support and split bulletin/individuality descriptors per environment.**

  Previewnet is a zombienet deployment running a Paseo runtime, replacing Paseo Next v1 as the priority test target. This release wires previewnet end-to-end across the SDK and, in the process, restructures bulletin and individuality descriptors to follow the same per-environment resolution pattern already used for asset-hub — so `descriptor.genesis` now matches the live chain instance the consumer connects to.

  ### What's new

  - **`getChainAPI("previewnet")`** routes to the zombienet endpoints at `previewnet.substrate.dev` for asset-hub, bulletin, and people (individuality).
  - **`BulletinChain.previewnet`** preset with the live previewnet bulletin genesis hash.
  - **`BULLETIN_RPCS.previewnet`** in `@parity/product-sdk-host` (additive).
  - **New descriptor packages**: `@parity/product-sdk-descriptors/previewnet-asset-hub`, `/paseo-bulletin`, `/previewnet-bulletin`, `/paseo-individuality`, `/previewnet-individuality`. Each embeds its own genesis hash and metadata blob.

  ### Breaking changes

  - **`@parity/product-sdk-descriptors`**: the shared `/bulletin` and `/individuality` exports are removed. Direct BYOD consumers must migrate:
    - `@parity/product-sdk-descriptors/bulletin` → `@parity/product-sdk-descriptors/paseo-bulletin` (or `/previewnet-bulletin`)
    - `@parity/product-sdk-descriptors/individuality` → `@parity/product-sdk-descriptors/paseo-individuality` (or `/previewnet-individuality`)
    - Named exports change correspondingly: `bulletin` → `paseo_bulletin`, `individuality` → `paseo_individuality`, etc.
  - **`@parity/product-sdk-chain-client`**: `PresetChains<E>` now resolves bulletin and individuality per environment. `ChainClientConfig.rpcs` requires a key for every environment the consumer supplies in `chains`. Consumers using `getChainAPI(env)` are unaffected at the call site — the typed return shape just becomes more precise.
  - **`@parity/product-sdk-bulletin`**: `BulletinNetwork.descriptor` is now `typeof paseo_bulletin | typeof previewnet_bulletin` (was a single type). The existing `BulletinChain.paseo.descriptor` continues to work; callers spreading `...BulletinChain.paseo` are unaffected.

  ### Why split the descriptors

  Bulletin and individuality run identical runtimes on paseo and previewnet today, but each environment is a separate chain deployment with its own genesis block. The previous shared-descriptor model exposed paseo's genesis hash regardless of the live chain — fine for SCALE encoding/decoding (PAPI validates runtime genesis from the live `chainHead`, not the descriptor), but misleading for any consumer using `descriptor.genesis` for chain identity (caching, telemetry, multi-chain dispatch). Per-environment descriptors keep the API surface honest and give us a clean separation point if the runtimes ever diverge.

  ### Endpoints wired

  | Chain                             | URL                                        |
  | --------------------------------- | ------------------------------------------ |
  | Previewnet Asset Hub              | `wss://previewnet.substrate.dev/asset-hub` |
  | Previewnet Bulletin               | `wss://previewnet.substrate.dev/bulletin`  |
  | Previewnet Individuality (People) | `wss://previewnet.substrate.dev/people`    |

  Statement-store routing requires no SDK changes — endpoints flow through the host container (configured in the mobile dev app builds), not our presets.

  ### Side fix

  The `paseo-individuality` descriptor regenerated against the live paseo people-next chain reflects the v1 → v2 redeploy: genesis is now `0xa22a2424...` (was `0xd01475...` in the stale shared descriptor). Consumers querying paseo people-next storage with the old descriptor would have seen schema-level decode mismatches against the v2 runtime.

### Patch Changes

- Updated dependencies [5d81610]
- Updated dependencies [5d81610]
  - @parity/product-sdk-host@0.2.1
  - @parity/product-sdk-descriptors@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [6fc8188]
  - @parity/product-sdk-descriptors@0.2.1

## 0.2.0

### Minor Changes

- 646d591: **Bump novasama 0.6 → 0.7 and polkadot-api 1.x → 2.x.**

  Aligns the workspace with the latest published `triangle-js-sdks` release line. novasama 0.7 crosses the `polkadot-api 1.x → 2.x` boundary, includes a structural rewrite of `@novasamatech/sdk-statement`'s subscription API, and renames the legacy-account methods on `AccountsProvider`. The PAPI peer-dep bump is itself a breaking change for any consumer pinning to PAPI 1.x.

  ### Catalog version changes

  | Package                          | Before    | After    |
  | -------------------------------- | --------- | -------- |
  | `polkadot-api`                   | `^1.23.3` | `^2.0.2` |
  | `@novasamatech/product-sdk`      | `^0.6.17` | `^0.7.5` |
  | `@novasamatech/sdk-statement`    | `^0.5.0`  | `^0.6.0` |
  | `@novasamatech/host-api`         | `^0.7.0`  | `^0.7.5` |
  | `@parity/host-api-test-sdk`      | `^0.6.0`  | `^0.7.3` |
  | `@polkadot-api/sdk-ink`          | `^0.6.2`  | `^0.7.0` |
  | `@polkadot-api/substrate-client` | `^0.5.0`  | `^0.7.0` |

  A `pnpm.overrides` entry pins `@polkadot-api/json-rpc-provider: ^0.2.0` to work around an upstream packaging bug in `@polkadot-api/json-rpc-provider-proxy@0.4.0` (declares its peer as a `devDependency`, lets the older `0.0.1` from `@substrate/connect`'s tree leak through).

  ### Breaking changes consumers will see

  #### `@parity/product-sdk-host`

  - **`HostStatementStore.subscribe` signature changed.** Was `subscribe(topics: Uint8Array[], callback: (statements: unknown[]) => void)`, now `subscribe(filter: StatementTopicFilter, callback: (page: StatementsPage) => void)`. Filter is structured (`{ matchAll: Topic[] } | { matchAny: Topic[] }`); callback receives pages of statements (`{ statements, isComplete }`) instead of raw arrays.
  - **`StatementProof` variants renamed.** Was `Sr25519 | Ed25519 | Secp256k1Ecdsa | EcdsaRecoverable`, now `Sr25519 | Ed25519 | Ecdsa | OnChain`. `Ecdsa` replaces `Secp256k1Ecdsa`; `EcdsaRecoverable` is gone; `OnChain` is new (chain-attestation-based proof referencing `{ who, blockHash, event }`).
  - **New exported types:** `StatementTopicFilter`, `StatementsPage`, `HostSubscription`.
  - **`AccountsProvider` method rename.** `getNonProductAccounts` → `getLegacyAccounts`, `getNonProductAccountSigner` → `getLegacyAccountSigner`. Public type updated.
  - **`JsonRpcProvider` import path** moved internally from `polkadot-api/ws-provider/web` (gone in PAPI 2.x) to `polkadot-api`. Consumers that imported it the same way should follow.

  #### `@parity/product-sdk-statement-store`

  - Subscription delivery is now page-based at the host boundary. The public `StatementClient.subscribe(callback, opts)` API is unchanged; the per-fire batch sizes may differ from the previous behavior.
  - No more `Secp256k1Ecdsa` / `EcdsaRecoverable` proofs reach `StatementClient` callers — code branching on those variants must handle `Ecdsa` / `OnChain` instead.

  #### `@parity/product-sdk-bulletin`

  - **`Binary.fromBytes` no longer needed.** PAPI 2.x's typed `tx` accepts `Uint8Array` directly. The `Binary` namespace itself dropped `fromBytes` — surface is now `{ toText, toHex, toOpaque, fromText, fromHex, fromOpaque }`. External code that called `Binary.fromBytes(...)` will break at runtime.

  #### Workspace-wide (PAPI 2.x)

  - **`polkadot-api/ws-provider/web` and `/node` subpaths are gone.** Consolidated into `polkadot-api/ws`. Imports targeting the old subpaths fail with `Cannot find module`.
  - **`Binary` namespace shape changed** — removed `fromBytes`, kept `fromText/fromHex/fromOpaque` and the `to*` counterparts.
  - **`JsonRpcProvider` callback shape.** `onMessage` now receives `JsonRpcMessage<any>` instead of `string`. `isResponse` and `isRequest` are now exported from `@polkadot-api/json-rpc-provider`.

  ### Bundle-size impact

  Net win across the board — no tree-shaking regression. Most packages shrank because PAPI 2.x dropped the WASM crypto path and novasama 0.7's accounts surface is leaner.

  | Entry                                                                        |     Bundled Δ |
  | ---------------------------------------------------------------------------- | ------------: |
  | `@parity/product-sdk-host`                                                   |          −11% |
  | `@parity/product-sdk-storage`                                                |          −11% |
  | `@parity/product-sdk-statement-store`                                        |          −11% |
  | `@parity/product-sdk-signer` (and `./wallet`)                                |          −10% |
  | `@parity/product-sdk-keys`                                                   |           −3% |
  | `@parity/product-sdk-tx`                                                     |           −3% |
  | `@parity/product-sdk-bulletin`, `chain-client`, `contracts`, `descriptors/*` | flat to −0.5% |

  Shake ratios held steady or improved across all entries.

  ### Verification

  - `pnpm install` clean, single `polkadot-api@2.0.2` and single `@polkadot-api/json-rpc-provider@0.2.0` in the tree.
  - `pnpm -r build` — all 24 workspace projects build (CJS + ESM + DTS).
  - `pnpm -r test` — 606 unit tests pass across 13 packages.
  - `pnpm test:e2e` — 57 pass, 3 skipped, 0 failed across all 9 demo apps. The 3 skipped tests are permission-rejection tests carrying `TODO(novasama-0.7-upgrade)` markers; novasama 0.7 caches the `TransactionSubmit` grant from initial connect rather than re-checking on each sign, and the test SDK's `revokePermission` no longer reaches the signing path. Re-enable when the test SDK and product-sdk converge on a per-sign permission contract.
  - `pnpm check` (biome) green.

  ### Migration notes for consumers

  1. **If you wrote against `HostStatementStore.subscribe`:** rewrite the call site to pass a `StatementTopicFilter` object and adapt your callback to `(page: StatementsPage) => void`. The page's `isComplete` flag tells you when the initial backfill has finished.
  2. **If you matched on `StatementProof.tag`:** replace `Secp256k1Ecdsa` and `EcdsaRecoverable` cases with `Ecdsa` and `OnChain`. The `OnChain` value shape is `{ who, blockHash, event }` — different from the `{ signature, signer }` shape of the others.
  3. **If you imported anything from `polkadot-api/ws-provider/web` or `/node`:** swap to `polkadot-api/ws`. For `JsonRpcProvider`, importing from top-level `polkadot-api` works cleanly.
  4. **If you used `Binary.fromBytes(data)` to wrap `Uint8Array`s for typed `tx` calls:** drop the wrapper — `Uint8Array` flows through directly.
  5. **If you called `accountsProvider.getNonProductAccounts()` or `getNonProductAccountSigner()`:** rename to `getLegacyAccounts()` and `getLegacyAccountSigner()`.

### Patch Changes

- Updated dependencies [646d591]
- Updated dependencies [646d591]
  - @parity/product-sdk-logger@0.1.1
  - @parity/product-sdk-descriptors@0.2.0
  - @parity/product-sdk-host@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-descriptors@0.1.0
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-logger@0.1.0
