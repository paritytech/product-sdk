# @parity/product-sdk

## 0.27.0

### Minor Changes

- 5613196: **Product-scoped proof contexts and personhood ring locations, as pure helpers.**

  Every context a host will sign under, and every context a product-derived runtime
  accepts, is `blake2b-256("product/" ++ productId ++ "/" ++ suffix)` with the
  RFC-0024 `Index`/`Raw` suffix expansion. `productContext(productId, suffix)`
  computes it offline, `contextSuffixBytes` exposes the expansion, and
  `personhoodContext(tld, name)` enumerates the five contexts the personhood
  product owns (`PERSONHOOD_CONTEXT_INDEX`) — needed because two of them never
  reach metadata. Product ids are always full DotNS ids (`"peopl.test"`,
  `"dim2.dot"`): the TLD belongs to the network and is never defaulted.

  `peopleRing(genesis)` and `litePeopleRing(genesis)` build the two personhood
  `RingLocation`s (the space-padded `CollectionId`s from `ringCollectionId`),
  structurally compatible with `@parity/product-sdk-host` without depending on it.

  `readScoreContext(chain)` reads `Score.score_context` and checks it equals
  `personhoodContext(<network suffix>, "score")`. A runtime publishing a literal
  context (which no stock host can mint) answers `NotProductDerived` on the ok
  channel, so proof-building flows stop before the chain rejects the transaction
  with nothing local to read.

  Where the network suffix comes from is part of the chain's type, not a runtime
  fallback: `NetworkSuffixChain` for the Root-settable `NetworkSuffix.NetworkSuffix`
  storage that individuality-community#20 introduced (read at a pinned block, since
  Root can move it), `LegacySuffixChain` for the `Score.Suffix` constant it
  replaced, and a `tld` option for a runtime with neither — which is every
  production runtime, since that pallet is testnet-only. A chain that can offer no
  suffix and no `tld` is a compile error rather than a runtime disappointment.
  `runScoreContextRead` is the throwing variant, so a composing read can run it
  against a block it already pinned instead of pinning a second one.

  First piece of the lite-personhood sign-up flow (product-sdk#286): consolidates
  the derivations dim2 and humanity each hand-roll today, pinned by the same
  vectors (previewnet's published constants, both collection ids).

- 5613196: **Full-personhood registration: `Score.register` builders, the readiness read, and `withScoreParticipant`.**

  The step after the score is in. `registerMessage(account)` pins the byte-exact proof-of-ownership contract — `"pop register using" ++ account`, a raw 50-byte concatenation, never SCALE — and `registerPersonhoodTx(chain, { memberKey, proofOfOwnership })` builds `Score.register(Some((member_key, sig)))` from it, width-checked (32-byte Bandersnatch member key, 64-byte plain signature). The pair is caller-supplied and opaque: only the personhood product's own host session can mint it (`registerRingVrfKey(Index(0), peopleRing)` + `ringVrfSign`), so the builder never tries, which lets the same code serve a cross-product handoff and a future single-product path unchanged. `readRegistrationEligibility` folds `Score.Participants` and `Score.PersonhoodThreshold` — a storage item on a session schedule, not a constant — at one pinned block into `readyToRegister`, also exported as the pure predicate.

  `withScoreParticipant(signer)` is the third signer on the origin-extension machinery `withAsPerson` and `withLiteAlias` share: it sets `RestrictOrigins`, reads the nonce back out of the `CheckNonce` slot PAPI filled, and writes `ScoreAsParticipant(Some(nonce))` — fee-free dispatch from a 0-balance participant account. No caller-supplied nonce, same as the siblings: the chain checks the extension's nonce against `CheckNonce`, and reading it back is what makes disagreement impossible. Encoding round-trips through the chain's own metadata, which is load-bearing here too: the extension is a newtype over `Option` of a newtype, and the plausible `{ nonce }` shape silently encodes `Some(0)` — measured, and rejected as a thrown `AsPersonError`.

  ```ts
  const eligibility = await readRegistrationEligibility(chain, { registrant });
  if (eligibility.ok && eligibility.value.readyToRegister) {
    const tx = registerPersonhoodTx(chain, { memberKey, proofOfOwnership });
    await submitAndWatch(
      tx,
      withScoreParticipant(accounts.getProductAccountSigner(account))
    );
  }
  ```

  Verified against the flow that ran live on previewnet (spec 1000036, individuality v0.12.1) on 2026-08-28.

- 5613196: **`withLiteAlias` runs a call under a lite-person origin, the way `withAsPerson` runs one under a person origin.**

  Wrap a signer and the `PeopleLiteAuth` transaction extension is filled inside `signTx`, where the nonce and the extension pipeline exist and are still patchable. Three variants: `AliasWithAccount` for calls signed by an account already bound to the lite alias (the free game sign-up leg, `Game.sign_up_with_account_lite_invite`), `AliasWithProof` for the unsigned, ring-VRF-authorized `PeopleLite.set_alias_account` bind leg, and `AliasWithAccountRevised` to refresh a stale binding. Proof messages are computed from the chain's own metadata — blake2-256 of the implication after `PeopleLiteAuth`, or the pallet's `(implication, "revise", account, nonce)` tuple — and never chosen by the caller.

  ```ts
  const signer = withLiteAlias(accounts.getProductAccountSigner(account), {
    tag: "AliasWithAccount",
  });
  await submitAndWatch(
    api.tx.Game.sign_up_with_account_lite_invite({
      account,
      identifier_key,
      airdrops,
    }),
    signer
  );
  ```

  The machinery under `withAsPerson` was already generic over the extension identifier; the slot patching, nonce read-back, proof-request guards and pipeline cache it kept file-private now live in an internal shared module, along with the ordered `signTx` body itself, so both signers run the same steps rather than two copies of them. Encoding is still round-tripped through the metadata of the blob being signed against, which is load-bearing here too: the devnet runtime declares the proof variants without the `RevisionIndex` field the deployed runtimes carry, and that mismatch is a thrown `AsPersonError` rather than a structurally plausible wrong encoding. No behaviour change for `withAsPerson`.

### Patch Changes

- Updated dependencies [5613196]
- Updated dependencies [5613196]
- Updated dependencies [5613196]
- Updated dependencies [5613196]
  - @parity/product-sdk-individuality@0.4.0
  - @parity/product-sdk-host@0.19.1
  - @parity/product-sdk-chain-client@0.12.3
  - @parity/product-sdk-cloud-storage@0.11.3
  - @parity/product-sdk-local-storage@0.3.9
  - @parity/product-sdk-signer@0.14.4
  - @parity/product-sdk-keys@0.3.24
  - @parity/product-sdk-contracts@0.10.7
  - @parity/product-sdk-tx@0.4.7

## 0.26.0

### Minor Changes

- d0260a1: **Decode a `PeopleAirdrops` draw event id back to its draw index.**

  `parsePeopleAirdropsEventId(eventId)` is the inverse of `peopleAirdropsEventId`. It returns the `u64` draw index, or `null` for anything that is not a `PeopleAirdrops` id — a `Game` id, a foreign base, a malformed string. `null` rather than a throw because `Airdrop.Events` holds both schedulers, so a caller sweeping it with `getEntries()` meets foreign ids as a matter of course.

  The package could previously only derive ids forward, from indices the caller already held. That holds for the `Game` path, which has a per-game count to enumerate from, but not for `PeopleAirdrops`, whose ids only arrive from that shared map.

- d0260a1: **Add `getLocaleProvider` for the host's selected language.**

  A product can now render in the language the user picked inside the host, rather than
  inferring one from `navigator.language` — which reports the operating system's preference
  and is wrong whenever the two differ.

  ```ts
  import { getLocaleProvider } from "@parity/product-sdk-host";

  const provider = await getLocaleProvider();
  const sub = provider?.subscribeLocale((locale) => {
    i18n.activate(
      SUPPORTED.has(locale.languageTag) ? locale.languageTag : "en"
    );
  });
  ```

  `subscribeLocale` fires with the current locale and again on every change; the returned
  `HostSubscription` carries `unsubscribe` and `onInterrupt`. `getLocaleProvider` resolves to
  `null` outside a host container.

  `languageTag` is a BCP 47 tag such as `"en"`, `"pt-BR"` or `"zh-Hans"`. The set is open — a
  host adds languages without an SDK release — so a product that ships no catalog entry for
  the tag it receives picks its own fallback.

  The `locale` domain arrived in `@parity/truapi` 0.12.0, already on the catalog.

- d0260a1: **Expose candidate progress as part of personhood state.**

  `derivePersonhoodState` now reports the consecutive attended games remaining on `Candidate`, accounting for streak-weighted score accrual and absence resets.

  **Breaking for candidate-state producers.** `gamesRemaining` is a required member of the exported `Candidate` variant, so hand-built states and exact fixtures must add it. Callers that only consume the derived state are unaffected.

- d0260a1: **`readCurrentGame` answers "is this player in?", and takes a PAPI client directly.**

  Pass `players` and the running game carries a `registration` read at the same pinned
  block. One person is keyed twice in `Game.Players` — by account and, once recognized,
  by alias — so every key the caller holds goes in and any hit is `Registered`. A key
  read that fails is `Unknown`, never `NotRegistered`, and does not fail the game read;
  leave `players` out and it is `Unchecked`. That path needs the new `GamePlayersChain`
  on top of `GameChain`; the existing call without `players` is unchanged.

  ```ts
  const game = await readCurrentGame(chain, {
    players: [
      { tag: "Account", accountAddress },
      { tag: "Alias", alias },
    ],
  });
  if (game.ok && game.value.tag === "Running") {
    game.value.registration.tag; // Registered | NotRegistered | Unknown | Unchecked
  }
  ```

  `fromPapi(client, api)` builds the chain shape every read here takes from a
  `PolkadotClient` and typed API the caller already holds, for products that resolve
  their own connection instead of using `@parity/product-sdk-chain-client`.

- d0260a1: **Remove `localStorage.clear()` — it was a silent no-op in a host container.**

  `createApp().localStorage.clear()` resolved successfully but did nothing in production (only logging at debug), while the `createFakeApp` test fake actually emptied — so a test asserting `clear()` wipes storage passed against code that no-ops for real users (#344).

  It can't be implemented: the host localStorage protocol exposes no key enumeration — only per-key `read` / `write` / `clear(key)` (a single-key remove) through `@parity/truapi` → `HostLocalStorage` → `LocalKvStore` — so there is nothing to iterate for a clear-all. Rather than keep a method that lies (or one that always throws), `clear()` is removed from `LocalStorageApi` and from the fake; the two now build through one shared `createLocalStorageApi` adapter, so they can no longer drift.

  **Migration.** Use `remove(key)` — supported at every layer — to delete keys individually. There is no clear-all; if you need one, track the keys your app writes and remove them.

  **Breaking for callers.** `app.localStorage.clear()` no longer exists: an untyped call throws `TypeError: app.localStorage.clear is not a function` where it used to resolve.

  **Breaking for implementors.** `clear` is gone from the exported `LocalStorageApi` interface, so anyone writing one inline — for example the `localStorage` override passed to `createFakeApp` — must delete their `clear` to keep compiling.

### Patch Changes

- Updated dependencies [d0260a1]
- Updated dependencies [d0260a1]
- Updated dependencies [d0260a1]
- Updated dependencies [d0260a1]
- Updated dependencies [d0260a1]
- Updated dependencies [d0260a1]
  - @parity/product-sdk-individuality@0.3.0
  - @parity/product-sdk-host@0.19.0
  - @parity/product-sdk-chain-client@0.12.2
  - @parity/product-sdk-cloud-storage@0.11.2
  - @parity/product-sdk-local-storage@0.3.8
  - @parity/product-sdk-signer@0.14.3
  - @parity/product-sdk-keys@0.3.23
  - @parity/product-sdk-contracts@0.10.6
  - @parity/product-sdk-tx@0.4.6

## 0.25.0

### Minor Changes

- 84134e0: **Surface a clear error when a host reply can't be decoded, instead of an opaque `RangeError`.**

  When the host app and the `@parity/truapi` version a product is built against are on different protocol versions, a host call can return a frame the client's SCALE codec can't decode. The truapi client catches that decode throw in its message handler and turns it into a promise rejection, then wraps the call with `fromSafePromise`, which installs no rejection handler — so the rejection escaped the `Result` channel rather than landing on its err side, surfacing as a raw `RangeError: Offset is outside the bounds of the DataView` with a stack that named neither the call nor the cause (reported for `createRingVRFProof`).

  The host boundaries now re-home that rejection onto the `Result` err channel (or, for the throwing helper, as a typed throw) as a new `HostResponseDecodeError` that names the failing call and preserves the original error as `cause`. This covers every path: `getAccountsProvider()`'s ten lookup methods, the flat public operations that fold through `mapHostResult` (`requestPermission`, `deriveEntropy`, `requestResourceAllocation`, …), and the adapter-object / signer methods that go through `unwrapHostResult`. Well-formed responses and each call's own typed `Err` values pass through untouched.

  New exports: the `HostResponseDecodeError` class (extends `HostError`, so `isHostError` / `instanceof HostError` catch it) and the `WithDecodeError<E>` type alias. Every `AccountsProvider` lookup method's `err` type is widened to `WithDecodeError<…>`; consumers matching on the err channel gain one additional case.

### Patch Changes

- Updated dependencies [84134e0]
- Updated dependencies [84134e0]
  - @parity/product-sdk-host@0.18.0
  - @parity/product-sdk-chain-client@0.12.1
  - @parity/product-sdk-cloud-storage@0.11.1
  - @parity/product-sdk-local-storage@0.3.7
  - @parity/product-sdk-signer@0.14.2
  - @parity/product-sdk-keys@0.3.22
  - @parity/product-sdk-contracts@0.10.5
  - @parity/product-sdk-tx@0.4.5

## 0.24.0

### Minor Changes

- 46e3592: **Export `subscribeConnectionStatus` for host-channel connection state.**

  Watching whether the host channel is up previously meant importing `@parity/truapi/sandbox`
  directly. The callback fires synchronously with the current status and again on every change;
  the returned function unsubscribes. Repeats of the status you already hold are suppressed.

  ```ts
  import {
    subscribeConnectionStatus,
    type HostConnectionStatus,
  } from "@parity/product-sdk-host";

  const unsubscribe = subscribeConnectionStatus((status) => setStatus(status));
  ```

  This is the **transport** channel — for the host's account-level connection, use
  `AccountsProvider.subscribeAccountConnectionStatus`. The type is `HostConnectionStatus` because
  `@parity/product-sdk-signer` already exports `ConnectionStatus` for a signer provider's lifecycle:
  same three states, different meaning.

  Also fixes a stuck status. `@parity/truapi` never clears its cached client when the pipe closes, so
  a subscriber arriving after a disconnect reported `"connecting"` — permanently, and for every other
  subscriber too. This holds `"disconnected"` until a real `"connected"` arrives. Still unfixed as of
  `@parity/truapi` 0.9.0, so the workaround stays until a later release drops it.

  **Testing.** `@parity/product-sdk-host/testing` gains `emitConnectionStatus(status)`, also on
  `FakeHost`, so a product can drive its reconnecting / offline UI. `setTruApiClient` now notifies live
  subscribers when it injects or clears a client.

  **Breaking for implementors.** `emitConnectionStatus` is a required member of the exported `FakeHost`
  interface, so hand-rolled test doubles must add it. Callers of `createFakeHost()` are unaffected.

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
- Updated dependencies [46e3592]
- Updated dependencies [46e3592]
  - @parity/product-sdk-chain-client@0.12.0
  - @parity/product-sdk-host@0.17.0
  - @parity/product-sdk-cloud-storage@0.11.0
  - @parity/product-sdk-signer@0.14.1
  - @parity/product-sdk-local-storage@0.3.6
  - @parity/product-sdk-individuality@0.2.0
  - @parity/product-sdk-contracts@0.10.4
  - @parity/product-sdk-keys@0.3.21
  - @parity/product-sdk-tx@0.4.4

## 0.23.0

### Minor Changes

- f987fd7: **Read a prize draw: derive its event id, then read its state and winner at one pinned block.**

  A prize draw is an `Airdrop` pallet event, and no storage entry lists it. Its 32-byte id is
  derived from a base plus a counter, so the derivation is the entry point to every read here.
  Two pallets schedule draws through the same mechanism and their layouts differ:

  ```ts
  import {
    gameAirdropEventId, // base(27) ++ airdrop_index(u8) ++ game_index(u32 BE)
    peopleAirdropsEventId, // base(24) ++ draw_index(u64 BE)
    readAirdropDraw,
    readGameAirdropEventIds,
  } from "@parity/product-sdk-individuality";

  const chain = await getChainAPI("paseo");
  const ids = await readGameAirdropEventIds(chain, {
    gameIndex,
    airdropsScheduled,
  });
  if (!ids.ok) return;

  const draw = await readAirdropDraw(chain, {
    eventId: ids.value[0],
    registrant: { tag: "Account", accountAddress },
  });
  if (draw.ok && draw.value.outcome.tag === "Won") {
    console.log(draw.value.outcome.ticket, draw.value.phase);
  }
  ```

  `readGameAirdropEventIds` reads `Game.airdrop_event_id_base` from the chain rather than
  assuming it. That is the point of it: `GAME_AIRDROP_EVENT_ID_BASE` is exported for tests and
  offline callers, and a hardcoded copy would go on deriving ids for draws that do not exist if
  the base ever moved, with nothing local to notice. `PeopleAirdrops`' base is _not_ exposed as a
  runtime constant, so that one is hardcoded and guarded by pinned vectors instead — there is
  nothing to read.

  **"Did I win" is a point lookup, not a scan.** `Airdrop.Winners` hashes the registration entry,
  so an identity is all it takes. Pass `registrant` and the outcome comes back as `Won` with the
  ticket, or `NotWon`. Omit it and the outcome is `Unchecked` — a third case on purpose, so "we
  did not ask" cannot be read as "did not win".

  **A draw that is not in storage is a success value, not an error.** It arrives as
  `phase: "Gone"` with `event: null`, which is the steady state for every past draw once the
  lifecycle cleans it up. It is not evidence the draw existed: an id that was never scheduled
  answers identically, and the chain cannot tell the two apart.

  **All reads share one finalized block**, like the personhood read, and the block is reported
  back on the result. A draw's phase and its winner set move together, so reading them a block
  apart can report a draw as still registering while it already holds its winners.

  The eight-variant chain `Status` is collapsed to a six-value `AirdropPhase`
  (`Upcoming`, `Registering`, `Drawing`, `Claiming`, `Settling`, `Gone`) for rendering, with the
  raw variant kept alongside it — the collapse is lossy, and an operator debugging a stalled draw
  needs to know whether it is waiting on randomness or already assigning winners.

  Three chain-data traps the compiler cannot catch, all handled here and all worth knowing if you
  read these entries yourself:

  - **`Status` fields are not uniform across its variants.** `total_participants` is absent in
    `Scheduled` and `Finalizing`, `effective_winners` in `Scheduled` and `Registering`, and
    `claimed` appears only from `Claiming` onwards. These are states a normal draw passes
    through, so `?? 0` is wrong in production, not in a corner case: a `Finalizing` draw did have
    participants, the chain just stopped carrying the figure. They map to `null`.
  - **`winner_cap` is a `Permill`** — parts per million, not a count and not a percentage.
    Exported as `winnerCapPermill` so it cannot be spent as a number of winners.
  - **The prize is a foreign asset.** `prize.assetId` is an XCM location, so formatting
    `assetAmount` with the chain's own `tokenDecimals` is wrong. Read `Assets.Metadata` for that
    id and use its `decimals`.

  `AirdropChain` is typed structurally, like `IndividualityChain`, so a test double satisfies it
  and the package still needs no runtime dependency on `@parity/product-sdk-chain-client`. A
  compile-time assertion in `@parity/product-sdk` checks that a real `getChainAPI` client still
  satisfies it. One thing that assertion cannot cover: PAPI's `SizedHex<N>` erases `N`, so
  `SizedHex<27>` and `SizedHex<32>` are mutually assignable and the base's width is unassertable
  in the type system. It is checked at runtime instead, against a pinned vector.

  **`readDrawRegistration` is new, and separate on purpose.** Before a draw runs, an absent
  `Winners` entry means "not drawn yet" and says nothing about whether you entered.
  `Airdrop.Registrations` is keyed by the 32-byte entropy slot with the registration entry as its
  _value_, so there is no reverse index — and the slot is the schnorrkel-expanded VRF output, which
  not even the player who minted the VRF holds. Answering therefore means scanning every
  registration under the event:

  ```ts
  const registration = await readDrawRegistration(chain, {
    eventId,
    registrant,
  });
  // registration.value.slot         — the slot, which is also the ticket, or null
  // registration.value.entriesScanned — what the scan cost
  ```

  It is its own call rather than a field on `readPrizeStatus` because the cost grows with the
  draw's participant count and nothing bounds it client-side. `entriesScanned` is reported so the
  cost is visible after the fact. Call it when a UI needs "you are in tonight's draw", not on every
  status poll.

  **Registration state is not read here.** "Am I registered, before the draw runs" is a prefix
  scan of every entry under the event: `Airdrop.Registrations` is keyed by the 32-byte entropy
  slot with the registration entry as its _value_, so there is no reverse index — and the slot is
  the schnorrkel-expanded VRF output, which not even the player who minted the VRF holds. The
  scan costs `total_participants` reads, unbounded from the client's side, so it does not belong
  inside a status call a UI polls.

- f987fd7: **Add `withAsPerson`, so a product can send a call that dispatches under a person origin.**

  `withAsPerson(signer, info)` wraps a `PolkadotSigner` and builds the People chain's `AsPerson`
  transaction extension around it. It returns a `PolkadotSigner`, so submission stays with
  `@parity/product-sdk-tx` and nothing there changes: pass the wrapped signer to `submitAndWatch`,
  `batchSubmitAndWatch` or `signSubmitAndWatch` as usual.

  Three variants are typed. `AliasWithAccount` needs no proof and is the everyday case, for an account
  already bound to an alias by `People.set_alias_account`: it reads the nonce from the slot PAPI
  already filled, so the extension's copy and the body's copy cannot disagree. `AliasWithProof` and
  `AliasWithAccountRevised` take a `createProof(message)` callback, which is handed the call
  implication hash. The message is computed here, never chosen by the caller, because it covers the
  nonce, the era, the tip and every other extension after `AsPerson`.

  Two things this handles that a hand-rolled extension does not. It sets `RestrictOrigins` to `true`,
  which PAPI defaults to `false` and which the origin-restriction pallet rejects outright for a person
  origin, before dispatch and with no dispatch error to read. And for `AliasWithProof` it supplies
  `VerifyMultiSignature` as `Disabled`, which is what makes the host assemble an unsigned general
  transaction so the origin is `None`, the only origin that variant accepts.

  Everything is encoded from the runtime metadata the transaction is being signed against, never from
  a hand-written type. The deployed `AsPersonInfo` and the upstream `polkadot-sdk` one both declare a
  variant named `AsPersonalAliasWithProof` with different field lists, so an upstream-derived encoder
  would emit plausible bytes with a field missing.

  The public surface is five names: `withAsPerson`, `AsPersonInfo`, `CreateRingVRFProof`,
  `RingVRFProof` and `AsPersonError`. The metadata-driven pieces underneath stay internal, but they are
  written generically, taking an extension identifier rather than hard-coding `AsPerson`, so the other
  origin-modifying extensions on this chain can reuse them when something needs them.

  Errors arrive as a thrown `AsPersonError`, not on a `Result` channel, because they happen inside
  `PolkadotSigner.signTx`.

  **`AliasWithProof` needs a runtime that paseo has not deployed yet, and the gap is not in the
  encoding.** `People.set_alias_account` requires the proof's context to be one the runtime allows
  accounts to be bound in. Individuality `v0.11.2`, which is what paseo-people-next runs today at
  `specVersion 1000032`, fixes those contexts as constants that no host-minted context can equal, so
  the chain rejects the call however correct the bytes are. Individuality `v0.12.0` derives them with
  the same product-scoped construction the host already uses, so
  `createRingVRFProof(keyHandle, { productId: "peopl.<network>", suffix: Index(0) }, ...)` produces
  exactly the context the call wants. Verified by computing both sides: they are byte-identical.

  So this needs no further SDK work and nothing from the host. When paseo upgrades to `1000035` or
  later, regenerate the descriptors and pass that context; the encoding here is already finished and
  tested against the deployed metadata.

- f987fd7: **Claim a prize: check whether you can, build the call, and confirm afterwards that it landed.**

  ```ts
  import {
    readClaimEligibility,
    claimPrizeTx,
    confirmClaim,
  } from "@parity/product-sdk-individuality";
  import { submitAndWatch } from "@parity/product-sdk-tx";

  const check = await readClaimEligibility(chain, {
    gameIndex,
    airdropIndex,
    registrant: { tag: "Account", accountAddress },
  });
  if (check.ok && check.value.claimable) {
    const tx = claimPrizeTx(chain, { gameIndex, airdropIndex, beneficiary });
    await submitAndWatch(tx, signer, { waitFor: "finalized" });
  }
  ```

  **`Game.claim_airdrop` has five gates and only two are about personhood.** A caller checking
  recognition alone still gets `NotEligibleForAirdrop`, `NotClaiming`, `ClaimingWindowClosed` or
  `NoSuchWinner` back from the chain with nothing local to explain them:

  | Gate                                | On-chain error                 |
  | ----------------------------------- | ------------------------------ |
  | recognized, or reached personhood   | `Game.NotEligibleForAirdrop`   |
  | `last_attended_game == game_index`  | `Game.NotEligibleForAirdrop`   |
  | the draw's status is `Claiming`     | `Airdrop.NotClaiming`          |
  | now is before the draw's `end_time` | `Airdrop.ClaimingWindowClosed` |
  | a `Winners` entry for this identity | `Airdrop.NoSuchWinner`         |

  `ClaimEligibility.blockers` carries **every** cause rather than the first found — a UI that says
  "not recognized" while the window has also closed sends the player to fix the wrong thing.
  `deriveClaimEligibility` is the pure form, for a caller that already holds a draw and a
  participant.

  **The binding deadline is not a timestamp.** Attending the next game overwrites
  `last_attended_game` and closes the claim, usually well before the draw's `end_time`. So
  `ClaimWindow` reports `closesOnNextAttendance` alongside `endTime`, because a countdown alone
  misleads. The runtime's own comment contemplates relaxing `==` to `>=`, which would make that
  `false` — the comparison is in one place for that reason.

  **Resuming after a reload needs no subscription.** A successful claim _removes_ the `Winners`
  row, so `confirmClaim` re-reads it: a ticket still present means the claim has not landed, and
  its absence means it has. That survives a reload, a dropped socket and a closed tab.

  The one caveat is honest in the type: if the draw has also left `Claiming`, the row could have
  been swept by the lifecycle instead, so the answer is `Unknown` rather than `Claimed`. Persist
  the ticket when you claim — it is the only local evidence separating "claimed" from "never won".

  **Submission stays with `@parity/product-sdk-tx`.** `claimPrizeTx` returns the unsigned PAPI
  transaction, so retries, batching and fee estimation work without this package knowing about
  them — the same split `withAsPerson` uses. For a person origin rather than a signed account, wrap
  the signer with `withAsPerson`; the call is identical, because `claim_airdrop` accepts both and
  derives the registration entry from whichever it got. The claim is `Pays::No`, so only a rejected
  one costs a fee.

  Two things worth knowing if you read these entries yourself. `Score.Participants` keys the alias
  variant `Person` where `Airdrop`'s registration entry calls it `Alias` — same identity, two
  spellings, and the wrong one reads nothing and looks like a missing record. And
  `readClaimEligibility` takes `now` in Unix **seconds**, defaulting to the device clock; pass the
  chain's own time if you have it, since a clock minutes fast will call a live window closed.

  **Also corrected:** `AirdropOutcome.NotWon` was documented as meaning "not drawn yet" or "did not
  win". It has a third meaning — **won and already claimed**, since claiming removes the row. The
  doc now says so.

- f987fd7: **Read the current game: its phase, the deadline that phase runs to, and what is scheduled next.**

  ```ts
  import { readCurrentGame } from "@parity/product-sdk-individuality";

  const chain = await getChainAPI("paseo");
  const result = await readCurrentGame(chain);
  if (!result.ok) return;

  if (result.value.tag === "Running") {
    const { index, phase, nextDeadline, airdropsScheduled } = result.value.game;
  } else {
    // No game right now — the chain's normal state between games.
    const next = result.value.upcoming[0];
  }
  ```

  **No game running is a success value, not an error.** One game exists at a time and each is
  killed when it ends, so `BetweenGames` is the state the chain is in most of the time. It carries
  `lastGameIndex` — the counter only moves when a game is _created_, so it still names the game
  that just ended, which is the index a prize from that game is claimed against. It is `null`
  before any game has ever existed, because games are numbered from 1.

  **The phase comes from the chain's `GameState`, never from comparing timestamps to a clock.**
  Transitions run in an offchain worker's own time, so a boundary can be in the past while its
  phase is still current. `nextDeadline` is selected from the stored boundary matching the phase,
  and is `null` for `PlayerProcess` and `Cancelling`, which end when their work finishes rather
  than at a time.

  **Stored boundaries and derived ones are kept apart on purpose.** A running game carries the
  boundaries it was created with, and `CurrentGame` reports those and never re-derives them —
  governance can change `Game.StoredPhaseDurations` afterwards, at which point a re-derivation
  would contradict the chain's own stored values. An upcoming schedule stores only its play time,
  so its boundaries have nowhere to come from _but_ derivation: `GameSchedulePreview.timeline`
  mirrors the runtime's `GameTimes` trait, saturating arithmetic included, and is documented as a
  projection that moves if the durations do. `gameTimeline` is exported for callers doing their
  own reads.

  Also exported: `readCurrentGame` reports the `durations` its projections were built with, so a
  caller can tell which source they came from — `Game.StoredPhaseDurations` when governance has
  set an override, and the `Game.DefaultPhaseDurations` constant otherwise. The constant is read
  only in the fallback case, which keeps the one un-block-pinned value in this read out of the
  common path. PAPI serves constants from the client's current runtime rather than from a block,
  so it can only disagree with the pinned block across a runtime upgrade landing mid-read.

  Two counts that look interchangeable and are not. `CurrentGame.airdropsScheduled` is how many
  draws the game _actually_ got — scheduling stops at the first failure — and is the count event
  ids may be derived from. `GameSchedulePreview.airdrops` is what a schedule _asks_ for, useful
  for showing a prize before the game exists and wrong for deriving ids.

  **The game surface is paseo-only for now, and the descriptors say so.** The committed devnet
  metadata predates the multi-airdrop game work: its `GameSchedule` carries a single optional
  `airdrop_prize` rather than a list of draws, its `GameInfo` has no `airdrops_scheduled`, its
  `PhaseDurationValues` still carries the `airdrop_claim_window` that moved onto each draw, and
  its `Game.airdrop_event_id_base` is 28 bytes to paseo's 27 — a different event-id layout
  altogether. A devnet client therefore fails `GameChain` structurally, and the compile-time
  contract in `@parity/product-sdk` asserts that failure deliberately, so a re-pinned devnet
  breaks the assertion instead of leaving the read quietly unsupported.

  That last divergence is worth knowing if you derive event ids yourself: nothing in the type
  system catches it, because PAPI's `SizedHex<N>` erases `N` and a 28-byte base satisfies every
  signature a 27-byte one does. The length check in `gameAirdropEventId` is the whole guard, which
  is why it throws rather than padding or truncating.

- f987fd7: **Resolve the DotNS contract addresses from chain state, instead of only trusting the pinned table.**

  The addresses in `DOTNS_ADDRESSES` are correct today, but nothing checked that. An earlier default set had no code deployed at any of its addresses, and every read returned "unregistered" with no error anywhere — the same silent shape as the TLD bug fixed in the previous release. This adds the two things that make that detectable.

  **`addressSource: "discovered"`** walks the deployment from chain state and trusts nothing compiled into the bundle: `DotnsGateway.DispatcherAddress` (pallet storage) → `dispatcher.TARGET()` → `popController.protocolRegistry()` → `protocolRegistry.get(key)` for the registry, registrar controller, forward resolver, reverse resolver and PoP rules. Four round trips, cached per runtime. The default stays `"pinned"`, which reads nothing.

  **`verifyDotNsAddresses(opts)`** does the same walk once and reports every role whose live address differs from the one the client would call, listing all of them rather than the first. Meant for startup: a product that keeps the pinned table can still fail loudly when a redeploy moves something.

  Both take their trust root from `DotnsGateway.DispatcherAddress`, a governance-set value on the chain the caller already relies on for every name read, a stronger anchor than a constant in a bundle.

  One thing to weigh before enabling it: discovery also selects the address the write helpers build calls against, so it decides where a signed transaction goes and not only where a read comes from. A pinned address constrains that destination even against a hostile RPC, and a discovered one does not. `verifyDotNsAddresses` is the check for products that want the pinned constraint and an alarm when it goes stale.

  **New exports.** `resolveDotNsAddresses`, `discoverDotNsAddresses`, `verifyDotNsAddresses`, `DOTNS_REGISTRY_KEYS`, and the types `DotNsAddresses` and `DotNsGatewayQueryApi`.

  **New `DotNsClientOptions` fields.** `addressSource?: "pinned" | "discovered"` (default `"pinned"`) and `gatewayApi?: DotNsGatewayQueryApi`. The gateway API is optional: `runtime.api` is used when it carries the pallet, and is probed rather than assumed, so a chain without `DotnsGateway` — Polkadot and Kusama Asset Hub — fails with a typed error rather than throwing.

  **Two new `DotNsErrorReason` members**, so a `switch` over the union in consumer code is no longer exhaustive: `"AddressDiscovery"` when the walk cannot locate the deployment, and `"AddressMismatch"` when verification finds drift. They are separate from `"RegistryCall"` because they are not per-call failures — the first means the client cannot find the deployment at all.

  **The registry keys are not the field names.** `registrarController` answers under `bytes32("controller")`, not `"registrar"` — that is the ERC-721 holding name ownership, a different contract at a different address. `resolver` answers under `"resolver"`, not `"contentResolver"`. Both wrong keys return a live address rather than an error, so the mistake surfaces much later as a revert. `protocolRegistry` has no key at all and is reached through the walk.

  **Behaviour unchanged by default.** Every existing call keeps reading the pinned table, no new round trips, and no published signature changed. Per-field address overrides continue to win over whichever source is in use.

  **Also corrected: Previewnet's TLD is `.test`, not `.dot`.** Documentation only — no behaviour change. The `.dot` fallback for a deployment whose `tld()` getter reverts empty is still correct for anything predating `dotns` `b4096968`, but Previewnet was cited as the live example and is not one. No live deployment is currently known to take that branch.

- f987fd7: **Add the DotNS registry surface under `@parity/product-sdk/identity`.**

  Introduces reads (`resolveDotNs` / `reverseDotNs` / `isDotNsAvailable`) and writes (`setDotNsRecord` / `prepareDotNsRegistration`), plus `DotNsClientOptions`, `RegisterDotNsArgs`, `SetRecordArgs`, `DotNsRegistration`, a `DotNsError` (`SdkError` marker, `source: "dotns"`), and the `namehash` / `dotNsTld` / `DOT_NODE` / `DOT_TLD` helpers. Everything returns a `Result<T, DotNsError>`.

  **Reads.** DotNS is an ENS-style set of Revive contracts on Paseo Asset Hub. `resolveDotNs` computes the namehash under the deployment's own TLD, reads `registry.owner(node)` and `registry.resolver(node)`, then `resolver.addressOf(node)`. It reports three states, because the registry's resolver pointer is configuration rather than proof of existence: `ok(null)` for an unregistered name, `ok({ name, owner })` for a name that is registered but has no forward record yet — the pointer is zero, or points at a resolver that is not the forward one (registration parks it on the reverse resolver, and a product name typically points at the content resolver; only the forward resolver answers `addressOf`), and `ok({ name, owner, address })` when it resolves. `isDotNsAvailable` asks `registrarController.available(label)`, the predicate `register` itself enforces. `reverseDotNs` calls `reverseResolver.nameOf(account)`, which the contract already verifies against current ownership.

  **Writes** return prepared calls the caller submits with their own signer. `setDotNsRecord` returns a `BatchableCall[]`: `registry.setResolver` first when the node is not yet pointed at the forward resolver, then `resolver.setAddress`. `prepareDotNsRegistration` returns the commit call, the secret, the timing window, and a `prepareRegisterCall()` thunk to invoke after `minCommitmentAge` has elapsed. Register is deferred because it consumes the commitment: building it up front cannot work. Registration is priced with `PopRules.priceWithoutCheck(label, owner)` plus `transferFloor` on the cross-payer path, matching what `register` charges, and a reserved label or an owner below the label's personhood tier fails before the caller pays for the commit.

  **`DotNsClientOptions.origin`** is the SS58 account that will submit the calls. Required by the write helpers, which dry-run against it since the resolver and registry writes are owner-gated. Optional for reads. Absent where required, it fails with `DotNsErrorReason` `"MissingOrigin"`; present but not decodable as SS58, `"InvalidOrigin"` — never a throw, since deriving the payer's H160 from it is the one step in the module that can raise.

  **Breaking for anyone who imported the old skeletons.** `resolveDotNs` / `reverseDotNs` / `isDotNsAvailable` previously took no options and **threw** `"not yet implemented"`; they now require `DotNsClientOptions` and return a `Result`. `DotNsRecord.address` is optional and both it and `owner` are typed `0x${string}` (H160, not SS58: convert with `h160ToSs58` if needed). `DotNsRecord.expiresAt` is never set, since this deployment has no on-chain expiry. Pre-1.0, so shipped as `minor` per RELEASES.md.

  Contract addresses default to the Paseo Asset Hub deployment and are all overridable. `isResolvableDotNsName` is exported alongside `isValidDotNsName`: the registrar only mints single labels, but the registry supports subnodes, so `bob.alice.paseo` resolves even though it cannot be registered.

  **The TLD is per network, and read from the chain.** DotNS fixes its top-level domain when `DotnsProtocolRegistry.initialize` runs — `.paseo` on Paseo Asset Hub Next V2, `.dot` on Previewnet, operator-chosen elsewhere — and every name is a hash chain rooted at it. The SDK asks `protocolRegistry.tld()` once per runtime and caches it, rather than assuming a root: hashing under the wrong one produces a node the chain never wrote to, so a registered name reads back as unregistered with no error anywhere. The contract addresses, by contrast, are CREATE3-deterministic and identical on every network, which is why `PASEO_ASSETHUB_DOTNS` has been renamed `DOTNS_ADDRESSES` — the old name implied a per-network address table that does not exist. Only the TLD varies.

  A deployment older than `dotns` `b4096968` has no `tld()` getter; there the TLD was a compile-time `.dot`, so an absent getter falls back to `.dot` with a warning. Any other failed read is an error, never a guess.

  **Two behaviours changed for callers.** A name carrying another deployment's suffix is now refused with `DotNsErrorReason` `"TldMismatch"` instead of being hashed under our own root: `alice.dot` and `alice.paseo` are separate registrations that may have different owners, so translating between them silently could hand back a stranger's address. And a bare _multi-label_ name is no longer completed with the suffix — `bob.alice` was previously read as `bob.alice.dot`, and is now refused, because telling it apart from `alice.dot` would need a hardcoded list of every network's TLD. A bare single label still works: `alice` resolves as `alice.paseo`.

  **New options.** `DotNsClientOptions.tld` supplies the TLD directly, skipping the chain read for offline or test use — build it with `dotNsTld(".paseo")`, since a suffix paired with the wrong node is rejected. `DotNsClientOptions.protocolRegistryAddress` overrides the contract the TLD is read from, completing the set of address overrides.

  **New exports and signatures.** `DotNsTld`, `dotNsTld(suffix)`, `DOT_TLD`, `stripSuffix`, `isConsistentDotNsTld`, and three `DotNsErrorReason` members: `"TldMismatch"` above, `"InvalidTld"` for a deployment reporting a TLD we cannot use, and `"InvalidOrigin"` above. `namehash(name, tld)` now requires the root, and `normalizeDotNsName` / `isValidDotNsName` / `isResolvableDotNsName` each require the deployment's suffix. Defaulting them was rejected deliberately: a default correct on one deployment is the defect this change fixes.

  **Lite-person names must be passed flattened.** A lite registrant reserves a dotted label (`alice.42`) and the contract strips the dots before hashing, so the registry stores `alice42`. Resolve `alice42.paseo`, not `alice.42.paseo` — the dotted spelling derives a different node and finds nothing.

  **One new failure mode.** `isDotNsAvailable` and `prepareDotNsRegistration` pass the bare label and let the contract derive the node, so they were unaffected by the rooting bug — but they now depend on the TLD read for validation, and a protocol-registry read failure fails a call that previously succeeded.

- f987fd7: **Sign up for the game, and enter its prize draws in the same call.**

  ```ts
  import {
    readGameSignUpRequirement,
    mintAccountAirdropVrfs,
    signUpWithAccountTx,
  } from "@parity/product-sdk-individuality";
  import { submitAndWatch } from "@parity/product-sdk-tx";

  // `accounts.signVrf` takes the account first and returns a Result, so it needs an
  // adapter. `txSigner` is the ordinary PolkadotSigner, not the same object.
  const vrfSigner = {
    signVrf: (label, items) =>
      accounts.signVrf(account, label, items).match(
        (sig) => sig,
        (cause) => {
          throw cause;
        }
      ),
  };

  const req = await readGameSignUpRequirement(chain, {
    registrant: { tag: "Account", accountAddress },
    keyType: "sr25519",
  });
  if (!req.ok || !req.value.canSignUp) return;

  let airdrops;
  if (req.value.canEnterDraws) {
    const vrfs = await mintAccountAirdropVrfs(vrfSigner, {
      eventIds: req.value.eventIds,
      publicKey: account.publicKey,
    });
    if (!vrfs.ok) return;
    airdrops = vrfs.value;
  }

  const tx = signUpWithAccountTx(chain, {
    identifierKey,
    airdrops,
    airdropsScheduled: req.value.airdropsScheduled,
  });
  await submitAndWatch(tx, txSigner, { waitFor: "finalized" });
  ```

  **Registering for the game and entering its prize draws are one extrinsic.**
  `sign_up_with_account` takes `airdrops: Option<AirdropVrfs>` holding exactly one VRF per
  scheduled draw, in airdrop-index order. Pass nothing to sign up without entering any draw.

  **The `AirdropVrfs` variant is not the caller's choice** — the chain picks it from the player's
  `Score` recognition and rejects the other one with
  `Game.InvalidAirdropVrfVariantForRecognition`:

  | `recognition.is_recognized()`                 | Required variant                     | Buildable |
  | --------------------------------------------- | ------------------------------------ | --------- |
  | `false` — `NotRecognized`, `Suspended`        | `Account` — sr25519 VRFs             | yes       |
  | `true` — `Recognized`, `ExternallyRecognized` | `Alias` — ring-VRF membership proofs | **no**    |

  `Suspended` is _not_ recognized, so a suspended player stays on the account path — the check is
  `is_recognized()`, not "anything but `NotRecognized`".

  **Recognition is only half the gate.** The account arm also destructures the origin, so a
  **person** who is not recognized satisfies neither arm: the account variant wants an account
  origin, the alias variant wants recognition. Such a player can sign up but can enter no draw,
  which is the `AccountVrfsNeedAnAccount` blocker. Worth knowing because a rejected sign-up costs a
  fee, `Pays::No` applies on success only, and the airdrop registration rides inside the same
  extrinsic, so a refused draw entry loses the game sign-up with it.

  **A recognized player cannot enter the draws through any SDK or host available today.** The
  `Alias` variant needs a ring-VRF proof at the context
  `blake2_256("pop:polkadot.network/airdrop" ++ event_id)`, and every context a host will sign
  under is `blake2b_256("product/" ++ productId ++ "/" ++ suffix)`, computed by the host itself
  from a `ProductProofContext` that admits nothing else. The two preimages cannot be made to
  agree, so this needs a chain or host change rather than more SDK code. It surfaces as the
  `AliasVrfsUnavailable` blocker, and it is why `signUpWithAccountTx` offers no `Alias` argument:
  an argument that always fails on chain is worse than no argument. **Such a player can still sign
  up** — with no draw entry — which is the whole difference the blocker makes.

  **Gate the sign-up on `canSignUp`, and only the draw entry on `canEnterDraws`.** A recognized
  player has `canSignUp: true` and `canEnterDraws: false`, so gating both drops them silently.

  **Read the requirement first; it is not optional.** Event ids are derived from the game index
  _and_ the draw count, which must come from the same block, and the entry count must equal
  `airdrops_scheduled` exactly. A count mismatch fails the whole sign-up, deposit included, and
  ids derived from a stale index address draws that do not exist.
  `GameSignUpRequirement.blockers` reports every cause rather than the first, and separates the
  ones that stop the extrinsic (`NoGameRunning`, `NotInRegistration`, `RegistrationEnded`,
  `AlreadyRegistered`) from the ones that stop only the draws (`AliasVrfsUnavailable`,
  `AccountVrfsNeedAnAccount`, `NoDrawsScheduled`, `NotSr25519`). Each tag names a condition that
  holds on its own: a game that scheduled no draws reports `NoDrawsScheduled`, not a variant the
  player could not have supplied anyway.

  **Only sr25519 accounts can take the account path**, because the pallet reinterprets the account
  id _as_ the sr25519 public key. Nothing on chain records which scheme a 32-byte account id
  belongs to, so this cannot be read — pass `keyType` (`"sr25519" | "ed25519" | "ecdsa"`) and get a
  `NotSr25519` blocker, or omit it and own the check. For the same reason the transcript's `signer` item must be the account that
  signs the sign-up, not any other key the player holds.

  `airdropVrfTranscript`, `airdropVrfDomain` and `AIRDROP_VRF_TRANSCRIPT_LABEL` are exported for a
  caller minting VRFs some other way. Both the transcript
  label and its domain prefix are module-level `pub const`s in the airdrop pallet, so unlike
  `Game`'s event-id base neither reaches metadata; the pinned test vectors are the only guard, the
  same situation the `PeopleAirdrops` event-id base is in.

  **There is no local VRF verification step.** dim2-spa verifies before submitting, because one
  bad entry fails the whole sign-up — but schnorrkel VRF verification has no implementation in
  this workspace, and the failure it guards against is the wrong signing key, which the transcript
  binds and this code checks without any crypto. VRFs are minted sequentially rather than in
  parallel: each is a signing operation, and firing sixteen at once is hidden by an `AutoSigning`
  allowance right up until a product ships without one.

  **Paseo only.** Devnet's pinned metadata predates the multi-airdrop sign-up: its call takes
  `airdrop`, singular, so `airdrops` would encode as `undefined` and enter no draw, silently. The
  umbrella contract test asserts a devnet client fails `GameChain & SignUpChain`. `SignUpChain`
  alone cannot reject devnet, since a `tx` argument is checked against a supertype and
  excess-property checking does not apply between named types; `GameChain` is the half that rejects
  it, by needing `airdrops_scheduled`.

- f987fd7: **`readPersonhoodState` now takes an account as well as a username, and every resolved answer carries the numbers behind it.**

  Two additions, both purely additive: no existing field changed and no state variant moved.

  `readPersonhoodState(chain, { account })` reads an account's standing directly. It _skips_ the `Resources.UsernameOwnerOf` lookup rather than adding a read, so the account path costs one round trip less than the username path — which is the common case for a profile or results screen, where an account is already in hand and the name is not. `UsernameUnowned` is unreachable on this path: nothing was looked up, so an account with no records resolves to `NotEnrolled`. Exactly one of `username` or `account` is accepted, checked at runtime: both, or neither, is an `err` result and costs no round trip. The option type rejects the obvious literal but not `{ username: maybeName, account: maybeAccount }` where both are `string | undefined`, so the runtime check is what holds the rule.

  Every `Resolved` result now carries `metrics`: `score`, `personhoodThreshold`, `misses`, `allowedMisses` and `window`, from the same pinned snapshot as the state and at no extra read. The state variants only carry payload where the derivation needs it — `Candidate` has a score, `Member` does not — so a UI rendering progress for everyone previously could not read a score off half the union. It can now, without switching on the tag.

  **`metrics.misses` is not `Caution.misses`.** The metric is what the window holds _now_. `Caution.misses` is a projection: what it would hold after one more absence, which is what the grace policy is evaluated against. A screen showing "you have missed 2 of the last 8 games" wants the metric.

  Two items from the same issue are deliberately not here. The `NotMember` host probe stays out of this read: it can only answer for the local user's own registered key, it needs a prior key registration that writes host-local state, and its `KeyNotRegistered` error — the fresh-install case — says nothing about personhood. `People.AccountToPersonalId` stays unread, because the specification behind this state machine says no PersonalId reaches the client, and the host's own identity model does not carry one either.

- f987fd7: **Account to username: `lookupUsername` reads `Resources.Consumers` (#302).**

  The SDK could answer "who owns username X" and not the direction products actually need on a results
  or profile screen: "what is this account's username". `lookupUsername(chain, { account })` answers it
  from `Resources.Consumers`, which is keyed by account and carries both names plus the credibility.
  Two apps and the host's own Rust core each hand-rolled this decode; this replaces all three.

  ```ts
  const result = await lookupUsername(chain, { account: rootAddress });
  if (result.ok && result.value) console.log(displayUsername(result.value));
  ```

  **An account with no consumer record is `ok(null)`, not an error.** The chain was asked and answered.
  Everything that can genuinely fail arrives on the `err` channel as a `ProductIndividualityError`,
  with `IndividualityDecodeError` for a shape the descriptor says is impossible.

  The record is `{ liteUsername, fullUsername, credibility }`, plus three pure helpers:
  `displayUsername` (the claimed name, else the lite one), `canClaimFullUsername`, and `usernameBase`.
  The read pins no block by default: it reads the finalized head at call time and reports no block
  back, so pass `at` a `readPersonhoodState` result's `at.blockHash` when both answers must describe
  the same block.

  Four properties come from the pallet rather than from the descriptor, and none is visible to the
  compiler:

  - **A lite username is always present and always `<letters>.<digits>`**; a full username is letters
    only, with no dot.
  - **`fullUsername === null` is the chain's own precondition for claiming a bare name**, which is what
    `canClaimFullUsername` reports. The chain writes `full_username` and `Credibility::Person` in the
    same statement, so "has a full name" and "is a person" are equivalent by construction.
  - **A demoted person keeps `Person` and keeps their full username.** Demotion rewrites only that
    flag, so nothing else in the record separates a demoted person from the rest. `demoted: false` is
    a weaker statement than it looks, though: the chain sets the flag only when somebody submits
    `demote_auth_expired`, and nothing submits it automatically, so it also covers a person whose
    authorization expired and who has not been demoted yet. `credibility.lastUpdate` is surfaced for
    exactly that: seconds since the epoch, as a `number`, to compare against the chain's
    `PersonAuthDuration` and tell a current authorization from a stale one. This package does not read that constant, so it hands back the timestamp rather
    than a verdict.
  - **An empty username is a decode error**, in both fields, and a name that is not valid UTF-8 fails
    loudly rather than becoming U+FFFD. Empty is impossible on chain, and reading an empty full
    username as absent would make `canClaimFullUsername` offer a claim the chain rejects, since
    `Some("")` is still `Some`.

  `displayUsername` is the same rule the host applies for `account.getUserId().primaryUsername`, so for
  the signed-in user the two should agree and a disagreement means a stale session snapshot.

  The chain parameter is typed structurally as `ConsumersChain`, so anything with the storage shape
  satisfies it, including a test double. A compile-time assertion in `@parity/product-sdk` checks a real
  `getChainAPI` client still satisfies it, so a descriptor regeneration that changes the entry fails
  `pnpm typecheck` rather than failing at runtime in a product.

  **Breaking, and the reason for the minor: `resolvePeopleUsernameOwner` now returns `SS58String`
  rather than `0x` hex.** It reads storage that yields SS58, and `Resources.Consumers` is keyed by
  SS58, so the old hex return made every account to username round trip carry a manual conversion.
  `wallet.signMessageWithDotNsIdentity` is unaffected: its `accountId` result is still `0x` hex.
  Callers who relied on the hex return get `accountIdToHex`, newly exported from
  `@parity/product-sdk/identity`, which is the inverse of the existing `accountIdHexToBytes` and keeps
  the same 32-byte check.

  `@parity/product-sdk-auth` gets a documentation fix only. Its `SessionAddresses.rootAddress` doc, and
  the `product-sdk-transactions` skill that repeats it, both told callers `rootAddress` was "the right
  input for `lookupUsername`" while no such function existed anywhere in the repo. Both now name the
  package it lives in.

  Re-exported from the umbrella as `@parity/product-sdk/individuality`. Documented by the
  `product-sdk-individuality` skill.

- f987fd7: **Read a game's prize draws and whether you won any of them, all at one block.**

  ```ts
  import { readPrizeStatus } from "@parity/product-sdk-individuality";

  const status = await readPrizeStatus(chain, {
    registrant: { tag: "Account", accountAddress },
  });
  if (status.ok && status.value.tag === "Draws") {
    for (const draw of status.value.draws) {
      if (draw.outcome.tag === "Won") console.log(draw.eventId, draw.phase);
    }
  }
  ```

  **This exists as one function because the composition is the hard part.** `readCurrentGame` and
  `readAirdropDraw` each pin their own finalized block when called alone, so assembling this by
  hand reads two blocks and can report a draw as still registering while it already holds its
  winners. `readPrizeStatus` pins once and hands the snapshot to every inner read.

  **Claiming after the game ends is the ordinary case, and it needs a count only you have.**
  `airdrops_scheduled` lives on `Game.Game`, which holds the _running_ game — but a claim window
  runs to the draw's `end_time`, by which point the chain has moved on and the ended game's draw
  count is unreadable. So pass what you captured while it ran:

  ```ts
  await readPrizeStatus(chain, {
    game: { index: 41, airdropsScheduled: 2 },
    registrant,
  });
  ```

  Supplying `game` skips the game read entirely — four fewer storage reads — so `game` on the
  result is `null` even if that index happens to be the running one. The result reports
  `drawCountFrom: "chain" | "caller"` so a consumer knows which it got.

  **There is no probe fallback, deliberately.** Probing event ids upward cannot distinguish a draw
  that was cleaned up from one that was never scheduled, so a short answer would read as "you won
  nothing" — the one wrong answer that matters here. Between games with no captured game, the
  result is `NoGame` carrying the upcoming schedule, rather than a guess.

  `readPrizeStatus` deliberately does not scan `Airdrop.Registrations`; `readDrawRegistration`
  does, and ships in the same wave.

  Internally, block pinning moved into one place so the inner reads can share a snapshot. No public
  API changed for that, and `readCurrentGame` / `readAirdropDraw` still pin their own block when
  called directly.

- f987fd7: **Removed: `deriveContextAlias`, `verifyContextAlias`, `ContextAliasInfo`.**

  Deprecated in `0.22.0`, which named `0.23.0` as the removal version. This is that release.

  `deriveContextAlias` returned addresses no key can spend: the alias public key was
  `blake2b256(parentPublicKey || context)`, a hash rather than a derived key, so no secret
  corresponded to the SS58 address or to the H160. Both could receive value and neither could ever
  send it. `verifyContextAlias` compared two public values, so a `true` result showed a derivation
  relationship and never that anyone controlled either account.

  Replace by intent:

  - An account that holds or spends value: `SignerManager.getProductAccount(dotNsIdentifier, index)`
    from `@parity/product-sdk-signer`. Host backed and actually signable.
  - The address offline, with no host: `deriveProductAccountPublicKey` from
    `@parity/product-sdk-keys`, the canonical sr25519 soft derivation.
  - An unlinkable per-context alias: select a registered ring VRF key, then
    `SignerManager.getProductAccountAlias(keyHandle, context, location)` or
    `createRingVRFProof(keyHandle, context, location, message)`.
  - A context-scoped identifier that was never an account: `blake2b256` from
    `@parity/product-sdk/crypto`. Same bytes, without the address packaging that invited the mistake.

  If you used an alias purely as an opaque identifier, the same 32 bytes are still available as
  `blake2b256(parentPublicKey || context)`. That is the hash, not either address form the old helper
  returned, so re-encode to match what you stored: `ss58Encode(blake2b256(...), 42)` reproduces the
  old `address`, and `deriveH160(blake2b256(...))` reproduces the old `h160Address`. Both are exact.

- f987fd7: **Fixes from review of the game and prize surface.**

  Two correctness fixes, both changing behaviour a caller can see.

  `readDrawRegistration` compared SS58 address strings, so the same account encoded under a
  different network prefix did not match and a player who was entered in a draw read as not
  entered. It now compares decoded public keys. Aliases keep the case-insensitive compare, since a
  32-byte alias really is hex. `addressesEqual` in `@parity/product-sdk-address` had the
  same limitation and is fixed the same way, so it now returns true for one account written
  under two prefixes and still returns false, rather than throwing, for a malformed input.

  `@parity/product-sdk-address` takes a `minor` rather than a `patch` for two reasons the repo's
  convention names: `publicKeysEqual` is new public surface, and the `addressesEqual` change is
  breaking under pre-1.0 semver, since a comparison that returned false now returns true.

  **Behaviour change worth reading if you use `addressesEqual`.** It now compares the account, not
  the encoding, so two SS58 strings for one key are equal even when their network prefixes differ.
  Anything that relied on the old string compare to tell networks apart needs the prefix from
  `ss58Decode` instead. The doc comment above the function said the opposite until now, which is
  fixed too.

  The correctness comes at a cost: a non-matching pair is decoded, roughly 20 microseconds, where an
  exact match still short-circuits for nothing. That is fine per call and adds up in a loop, so
  `publicKeysEqual` is now exported for that case. Decode the address you are searching for once
  with `ss58Decode`, then compare keys against each candidate.

  `confirmClaim` mapped every non-claiming draw to one of two phases, so a draw still assigning
  winners was reported as though the lifecycle had swept the winner row, which reads as "the window
  is over". It now reports the draw's real phase, and an unrecognised status variant fails on the
  error channel instead of being reported as some existing phase, matching every other decode here.

  **`claim_airdrop` has six gates, not five.** The prize asset must still be enabled for airdrops,
  and the check was missing. That matters because `Pays::No` applies only on success, so a claim
  this library green-lit and the chain refused cost the caller a fee. `readClaimEligibility` now
  reads `Airdrop.SupportedAssets` and reports a `PrizeAssetDisabled` blocker.

  **Breaking, before anything shipped:** `ClaimBlocker`'s `AttendedALaterGame` is now
  `DidNotAttendThisGame`. The chain tests `last_attended_game == game_index`, so the blocker also
  fires for a player who attended an earlier game or none at all, and the old name made a product
  render "you played again" to someone who never played. Compare `lastAttendedGame` to the game
  index to tell the three cases apart. `ClaimInputs` also gains a required `prizeAssetEnabled`.

  `claimPrizeTx` returned `unknown`, so the usage in its own documentation did not typecheck when
  passed to `submitAndWatch`. `ClaimChain` is now generic in the transaction type and the type is
  inferred from the chain, so the documented call compiles with no type argument and no cast.

  `readPrizeStatus`'s `NoGame` result now carries `lastGameIndex`, the game that just ended. That is
  the index a late claim is keyed by, and it was being discarded even though the underlying read
  returned it, forcing a second call on a second block.

  `ClaimEligibility.window` now documents what it does: the draw's deadlines whenever the draw
  exists, independent of whether this caller can claim. Read `claimable` for that.

  `readClaimEligibility` no longer reports `PrizeAssetDisabled` for a draw whose event row is gone.
  There is no asset id to look up there, so the gate is not applicable rather than failed, and
  `DrawNotClaiming` already explains the situation. `ClaimInputs.prizeAssetEnabled` is
  `boolean | null` for that reason.

  The registration scan builds its comparison once instead of per entry, which halved the time on a
  10,000-entry draw in a local measurement. It also makes a malformed account address fail the same
  way every time, where before it threw only if the draw happened to contain an account entry and
  answered "not registered" otherwise.

  The `product-sdk-individuality` skill now documents the game, the draws and the claim, including
  the six gates, the fee on a refused claim, and why the claim deadline is not a timestamp.

- f987fd7: **Preserve the underlying host error as `cause` on `HostRejectedError` (#289).**

  Six of the seven `HostProvider` account methods discarded the host's own error once they
  had formatted it into a message, so a signer-layer consumer could only recover the reason
  by matching on the message text. They now pass it through, and `HostRejectedError` accepts
  it as a third optional `ErrorOptions` argument, the same way `SigningFailedError` and
  `AllowanceExpiredError` already did.

  `error.cause` is the raw TrUAPI envelope, untouched — `scale.CallErrorValue<Versioned…Error>`
  for the call that failed. Its tagged union narrows exhaustively and already separates a
  domain rejection from a transport failure, so no hand-written gate is needed to tell the
  two apart:

  ```ts
  import type {
    scale,
    VersionedHostAccountCreateProofError,
  } from "@parity/truapi";
  import { isErrorOf } from "@parity/result";

  const result = await manager.createRingVRFProof(
    handle,
    context,
    ring,
    message
  );
  if (!result.ok && isErrorOf(result.error, HostRejectedError)) {
    const raw = result.error
      .cause as scale.CallErrorValue<VersionedHostAccountCreateProofError>;
    if (raw.tag === "Domain" && raw.value.value.tag === "NotAllowlisted") {
      // Degrade: this host has no allowlist source yet.
    }
  }
  ```

  `NotAllowlisted` on a cross-product proof or `ringVrfSign` is the expected steady-state
  answer on core-based hosts rather than a fault — the gate compares the key handle's owner
  against the calling product and reads no manifest, so no allowlist entry can exist yet
  (paritytech/host-rust-core#373). Android prompts and succeeds on the same request, so a
  product spanning both needs to branch on this to degrade per host.

  Covers `registerRingVrfKey`, `listRingVrfKeys`, `getProductAccountAlias`,
  `createRingVRFProof`, `getUserId`, `signVrf` and `getProductAccount`. A provider method
  that throws instead of rejecting keeps its own error on `cause` rather than losing it,
  which is the shape a host predating a call fails in.

  **`nonTransient` now answers consistently, which is a behaviour change.** It is classified
  from the host's error at every method instead of only at `getProductAccount`, so a signed-out
  host (`NotConnected`) reports `nonTransient: true` from `registerRingVrfKey`,
  `listRingVrfKeys`, `getProductAccountAlias`, `createRingVRFProof`, `getUserId` and `signVrf`,
  where it previously reported `false`. Those six could not classify before, because the error
  they needed had already been discarded. If you branch on `nonTransient`, a signed-out user now
  reaches your read-only path on all seven calls rather than one, which is what the field is
  documented to mean. Nothing inside the SDK changes behaviour: its one internal reader takes
  its value from `getProductAccount`, which already classified correctly.

  `HostUnavailableError` also takes an optional `ErrorOptions` now, and a failed
  accounts-provider load carries the error the loader threw, instead of only its message text.

  Reading `cause` at this layer means depending on `@parity/truapi` for the cast. Consumers
  wanting fully-typed handling without one should call `getAccountsProvider()` from
  `@parity/product-sdk-host`, where TrUAPI's types already flow through untouched — the same
  place `ringVrfSign` and `findRingVrfKeyHandle` live.

### Patch Changes

- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
- Updated dependencies [f987fd7]
  - @parity/product-sdk-individuality@0.2.0
  - @parity/product-sdk-signer@0.14.0
  - @parity/product-sdk-address@0.2.0
  - @parity/product-sdk-contracts@0.10.3
  - @parity/product-sdk-keys@0.3.20
  - @parity/product-sdk-tx@0.4.3
  - @parity/product-sdk-cloud-storage@0.10.2

## 0.22.0

### Minor Changes

- 3655724: **Wrap `account.signVrf` (RFC-0023) in the accounts surface (#288).**

  Producing an sr25519 VRF over a caller-supplied Merlin transcript previously meant
  reaching for the raw `getTruApi()` client. `AccountsProvider` now has
  `signVrf(account, transcriptLabel, items)`, with `HostProvider.signVrf` and
  `SignerManager.signVrf` alongside `createRingVRFProof`. Bytes in, bytes out: the adapter
  owns the hex encoding and the tagged derivation-index selector, and errors use the same
  `Result` channel as every other account call.

  New exported types, also re-exported from `@parity/product-sdk-signer`:
  `VrfTranscriptItem`, `VrfSignature`, and `ProductAccountLookup`
  (`{ dotNsIdentifier, derivationIndex? }`), which a `ProductAccount` satisfies.

  **Breaking for implementors.** `signVrf` is a required member of the exported
  `AccountsProvider` interface, so alternative implementations and hand-rolled test doubles
  must add it. Callers are unaffected, and the fake at `@parity/product-sdk-host/testing`
  already implements it.

  **Host-only.** There is no `DevProvider` implementation and the e2e test host does not
  expose the call, so this returns `HOST_UNAVAILABLE` outside a host container, matching
  `createRingVRFProof`. Use `createFakeHost()` for local tests.

  The caller owns four things the types cannot enforce:

  - _Domain separation_ — a label borrowed from another protocol makes the output
    replayable across both.
  - _Freshness_ — the VRF is deterministic, so per-round values must enter the transcript
    as items; otherwise every call returns the same signature.
  - _Size_ — hosts cap the transcript at 32 items and 8 KiB total and reject anything
    larger as an unknown error. The SDK does not pre-validate.
  - _Authorization_ — an `AutoSigning` allowance makes these calls silent. It is not
    VRF-scoped, so granting it also authorizes other signing with that account.

  Hosts predating the call reject it through the error channel rather than hanging.

- 3655724: **Deprecate the context-alias helpers, delete the unimplemented ring-alias stubs (#287).**

  `deriveContextAlias` returns addresses that can receive value and can never spend it: the alias
  public key is `blake2b256(parentPublicKey || context)`, a hash rather than a derived key, so no
  secret corresponds to the SS58 address or the H160. The address encodes and validates fine, so
  nothing surfaces until value arrives at it.

  **Deleted:** `deriveAnonymousAlias`, `createRingProof`, `verifyRingProof`, `AnonymousAliasInfo`,
  and identity's `RingLocation`. Each function was a debug log followed by an unconditional
  `throw`, with no branch or early return, so no working consumer could exist and this break is
  compile-time only. The real ring VRF operations already live on `SignerManager` in
  `@parity/product-sdk-signer` as `getProductAccountAlias(keyHandle, context, location)` and
  `createRingVRFProof(keyHandle, context, location, message)`, host-backed and using an opaque
  registered key handle selected by ring. Identity's `RingLocation` was also the wrong shape,
  `{ringIndex, memberIndex}` against the protocol type `{chainId, junctions}`.

  **Deprecated, removal in `@parity/product-sdk` 0.23.0:** `deriveContextAlias`,
  `verifyContextAlias`, `ContextAliasInfo`. Their output is unchanged, so a caller using an alias as
  a plain identifier has a release to migrate. `verifyContextAlias` compares two public values with
  no secret involved anywhere, so it confirms a derivation relationship and authenticates nothing.

  The derivation output is deliberately unchanged: the same name and signature returning different
  bytes would break identifier consumers silently, with no compile error.

  ### Migration

  | If you used it for                                    | Use instead                                                                                                                                                                                                      |
  | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | An account that holds or spends value                 | `SignerManager.getProductAccount(dotNsIdentifier, index)` from `@parity/product-sdk-signer`                                                                                                                      |
  | The address offline, with no host                     | `deriveProductAccountPublicKey` from `@parity/product-sdk-keys`, the canonical sr25519 soft derivation                                                                                                           |
  | An unlinkable per-context alias                       | Select a registered key by ring, then call `SignerManager.getProductAccountAlias(keyHandle, context, location)` or `createRingVRFProof(keyHandle, context, location, message)` from `@parity/product-sdk-signer` |
  | A context-scoped identifier, never used as an account | `blake2b256` from `@parity/product-sdk/crypto`: the same bytes, without address packaging                                                                                                                        |

  The DotNS half of `./identity` is unaffected (`resolveDotNs`, `reverseDotNs`, `isDotNsAvailable`,
  `resolvePeopleUsernameOwner` and the name helpers), and the subpath itself is not deprecated.

  `@parity/product-sdk-signer` takes a patch here for the context-alias migration wording. The
  separate TrUAPI 0.9 changeset documents the `RingLocation` type break and supplies the release's
  minor bump.

- 3655724: **Re-pin `paseo-individuality` and `paseo-asset-hub` after a genesis reset (#242).**

  Both chains were re-genesised, not upgraded, so the bundled descriptors addressed chains that
  no longer exist. Access is gated on
  `featureSupported({ tag: "Chain", value: { genesisHash } })`, so a stale genesis fails at
  connection with `ChainNotSupportedError` before any storage read. A stale `codeHash` only
  means decoding against an old metadata snapshot; a stale genesis means addressing a chain
  that is not there.

  | Chain                 | Old genesis           | New genesis           |
  | --------------------- | --------------------- | --------------------- |
  | `paseo-individuality` | `0xc5af1826…65afa5`   | `0x89a63b11…48c5440f` |
  | `paseo-asset-hub`     | `0xbf0488db…ae4ef19f` | `0x23e730eb…f94a2ca6` |

  **Breaking for `paseo-individuality`: the regeneration removes typed API surface.** A green
  `pnpm typecheck` here does not clear consumers, so check this before upgrading.

  | Pallet      | Removed                                                                   | Replacement                                                     |
  | ----------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
  | `Resources` | storage `FriendRequestRegistrationByAlias`, `FriendRequestAliasByAccount` | `NotificationRegistrationByAlias`, `NotificationAliasByAccount` |
  | `Resources` | 6 `FriendRequest*` constants                                              | 4 `Notification*` constants                                     |
  | `Game`      | storage `Nfts`, `NftCandidates`                                           | none                                                            |
  | `Coinage`   | storage `RecyclersUnloaded`                                               | `RecyclerAliasStates`, `RecyclersArchives`                      |

  `FriendRequestAllowance`, `FriendRequestSlotsPerPeriod`, `LiteFriendRequestSlotsPerPeriod` and
  `FriendRequestPeriodDuration` map onto `Notification*` equivalents.
  `FriendRequestGraceWindow` and `FriendRequestRetentionDuration` have no counterpart.

  Added to `paseo-individuality`: pallets `RelayRandomness` and `NftCredits`, `Game` storage
  `LiteInvites`, `Game` constant `max_received_votes`.

  `paseo-asset-hub` is additive only: pallets `Scarcity` and `NftClaims`, plus `DotnsGateway`
  constants `MaxValiditySeconds` and `MaxFutureSkewSeconds`. Safe to upgrade.

  Minor rather than patch because surface is removed, which on 0.x signals a breaking change.
  This is a firmer reason than the additive-only argument used for the 0.9.0 `paseo-bulletin`
  bump. A re-pin that neither adds nor removes pallets stays a patch, as in 0.8.0.

  If you pinned either hash yourself, read it from the descriptor (`loadDescriptors()`) instead.
  Paseo Next is re-genesised periodically, so any copy goes stale on its own schedule.

  The five other chains reported in #242 have unchanged genesis and need a separate routine
  regeneration. #242 stays open until those land.

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

- 3655724: Add `AccountsProvider.ringVrfSign(keyHandle, message)`, the plain signature under a
  registered ring-VRF member key for protocols that carry their own proof, as opposed to
  `createRingVRFProof`, which proves ring membership. It takes the same opaque
  `RingVrfKeyHandle` as the alias and proof calls, from `listRingVrfKeys` /
  `findRingVrfKeyHandle`, and hands back the signature as bytes. `SignerManager` does not
  wrap it; call the host package's `AccountsProvider` directly.

  **Breaking for implementors.** `ringVrfSign` is a required member of the exported
  `AccountsProvider` interface, so alternative implementations and hand-rolled test doubles
  must add it. Callers are unaffected, and the fake at `@parity/product-sdk-host/testing`
  already implements it.

- 3655724: **New package `@parity/product-sdk-individuality`: read a person's personhood state from the individuality chain (#287).**

  `readPersonhoodState(chain, { username })` answers one question — for a DotNS username, what
  is that person's standing on the individuality chain? — and answers it from **one pinned
  finalized block**. It returns a `Result<PersonhoodResult, ProductIndividualityError>`, per the
  SDK-wide error model, so nothing throws. Two of the six underlying values (`Score.PersonhoodThreshold` and
  `Score.AbsenceGraceRatio`) are session-updated with schedules behind them, so an unpinned
  batch can mix eras and still look valid. The block used is reported back on every result.

  The answer is a closed union of seven states, discriminated by `tag`:

  | `tag`             | Payload                                                 |
  | ----------------- | ------------------------------------------------------- |
  | `NotEnrolled`     | —                                                       |
  | `Lite`            | —                                                       |
  | `Candidate`       | `score`, `personhoodThreshold`                          |
  | `MembershipReady` | —                                                       |
  | `Member`          | `activeWeeks`, `lastAttendedGame`                       |
  | `Caution`         | `misses`, `allowedMisses`, `window`, `lastAttendedGame` |
  | `Suspended`       | —                                                       |

  wrapped by `UsernameUnowned | Resolved`, both carrying `{ blockHash, blockNumber }`.

  **`UsernameUnowned` is a success value, not an error.** The chain was asked and answered
  that nobody owns that username, so it arrives as `ok({ tag: "UsernameUnowned", ... })`.

  **Everything that can fail arrives on the `err` channel**, typed as
  `ProductIndividualityError` and recognised by `isSdkError`. Two kinds reach it:
  `IndividualityDecodeError` when the chain returns a shape the descriptor says is impossible,
  and the base error carrying anything else as its `cause` — an unreachable node, an aborted
  signal, or the pinned block leaving the follower's window mid-read. Error messages are fixed
  strings and never interpolate chain data.

  The grace-policy decode enforces the runtime's own invariants (`window <= 8` and
  `allowedMisses < window`), so a byte order that was ever wrong fails loudly rather than
  silently making `Caution` unreachable for every member.

  **Not an authorization oracle.** This is a client-side read in a client-side library, and a
  backend that trusts "the SDK said `Member`" is trivially spoofed. Anything gating value must
  verify on chain itself. Stated again in the module doc and the package skill.

  **The derivation is exported separately from the read.** `derivePersonhoodState(snapshot)` is
  pure — no chain client, no host container — so callers doing their own reads, and the
  eligibility half tracked in #291, can consume the state machine on its own. Also exported:
  `decodeAbsenceGracePolicy` and `toPersonhoodParticipant` for turning raw
  `Score.Participants` and `Score.AbsenceGraceRatio` values into domain shapes.

  **Chain resolution stays with the caller.** The package accepts an already-connected client
  rather than resolving an environment itself, so which individuality chain is read is the
  caller's choice:

  ```ts
  const chain = await getChainAPI("paseo");
  const result = await readPersonhoodState(chain, { username: "alice.dot" });
  ```

  The parameter is typed structurally — anything exposing the storage entries satisfies it,
  including a test double — matching how `getBalance` and `resolvePeopleUsernameOwner` already
  type their chain arguments. A compile-time assertion in `@parity/product-sdk` checks that a
  real `getChainAPI` client still satisfies it, so a descriptor regeneration that changes an
  entry fails the typecheck. That also means no runtime dependency on
  `@parity/product-sdk-chain-client`: this package depends only on
  `@parity/product-sdk-errors`, `@parity/result` and `polkadot-api`.

  The alias is read from both `People.AccountToAlias` and `PeopleLite.AccountToAlias`,
  preferring the former. Both pallets carry the entry with the same shape, and a Lite person's
  alias lives in the second, so consulting only `People` would leave their alias-keyed
  participant record invisible and report them as `Lite`.

  Two traps worth knowing if you read these entries yourself, both invisible to the compiler
  and both verified against the committed metadata: `Score.PersonhoodThreshold` is a `u8`
  (PAPI types `u8` and `u32` alike as `number`), and `Score.AbsenceGraceRatio`'s byte order is
  `(allowed_misses, window)` — the metadata tuple is anonymous, so the order comes from the
  pallet's doc comment rather than the type. Use `decodeAbsenceGracePolicy` rather than parsing
  the hex yourself.

  Reading `game` or `airdrop` state, the eligibility derivation, and transaction construction
  are all out of scope here — see #291 and #290.

  Re-exported from the umbrella as `@parity/product-sdk/individuality`. Documented by the
  `product-sdk-individuality` skill.

- 3655724: **Update TrUAPI to 0.9 and require registered ring-VRF key handles.**

  `AccountsProvider`, `HostProvider`, and `SignerManager` now expose
  `registerRingVrfKey(index, ring)` and `listRingVrfKeys(owner, disclosure?)`. Registration returns
  the decoded ring-VRF public key; listing returns `RegisteredRingVrfKey` entries with opaque
  `RingVrfKeyHandle` values. `findRingVrfKeyHandle(keys, ring)` selects a handle by declared
  `RingLocation`, so products do not hard-code another product's derivation index.

  `getProductAccountAlias` and `createRingVRFProof` now require that handle as their first argument.
  This is a compile-time breaking change. It matches TrUAPI 0.9, where the host no longer chooses a
  ring member key implicitly and rejects malformed legacy requests before application dispatch.

  The dependency update also adopts TrUAPI's renamed derivation-index variants: `Index` replaces
  `Left` and `Raw` replaces `Right`. The SDK's ergonomic numeric product-account APIs are unchanged;
  the host adapter performs the `Index` conversion at the wire boundary.

  The signer package's re-exported `RingLocation` now uses TrUAPI's `` chainId: `0x${string}` ``
  instead of a plain `string`; callers loading chain IDs from configuration must narrow or validate
  them before assignment. Custom `HostProviderOptions.loadAccountsProvider` implementations must
  also provide the newly required `registerRingVrfKey` and `listRingVrfKeys` methods.

  `findRingVrfKeyHandle` is exported from `@parity/product-sdk-host`, not from
  `@parity/product-sdk-signer`, which re-exports the ring-VRF types only. A product depending on
  the signer package alone needs `@parity/product-sdk-host` as a second direct dependency for the
  selection step. Prefer the helper over an inline comparison: it requires the junction path to
  match in order and compares chain and collection ids case-insensitively, so a shortcut that
  checks only `chainId` can pick a key registered for a different ring on the same chain.

### Patch Changes

- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
- Updated dependencies [3655724]
  - @parity/product-sdk-host@0.16.0
  - @parity/product-sdk-signer@0.13.0
  - @parity/product-sdk-chain-client@0.11.0
  - @parity/product-sdk-individuality@0.1.0
  - @parity/product-sdk-cloud-storage@0.10.1
  - @parity/product-sdk-local-storage@0.3.5
  - @parity/product-sdk-contracts@0.10.2
  - @parity/product-sdk-keys@0.3.19
  - @parity/product-sdk-tx@0.4.2

## 0.21.0

### Minor Changes

- 5ccab21: **Regenerate `paseo-bulletin` descriptors for the upcoming `v0.0.22-paseo` runtime (spec `1_000_022`).**

  Metadata was extracted offline from the `polkadot-bulletin-chain` `v0.0.22-paseo` release wasm (`papi add --wasm`) ahead of its deployment to Paseo Next v2, which currently runs spec `1_000_021`. Merge/publish this once the runtime upgrade is enacted on-chain.

  Runtime changes surfaced in the descriptors:

  - New `DataRenewal` pallet (`pallet_bulletin_data_renewal`, pallet index 42) — new tx/query/event API surface, hence the minor bump.
  - `renew`, `force_renew`, `enable_auto_renew` and `disable_auto_renew` **move off `TransactionStorage`** onto the new pallet. `CloudStorageClient.renew()` builds the old call via `@parity/bulletin-sdk`, so it will throw until that package is repointed at `DataRenewal.renew`.

  The pinned `codeHash` is pre-set to the release blob's blake2-256 (`0xabb9c076…`, matching what on-chain `:code` will hash to after the upgrade); `genesis` is unchanged.

### Patch Changes

- Updated dependencies [5ccab21]
  - @parity/product-sdk-chain-client@0.10.0
  - @parity/product-sdk-cloud-storage@0.10.0

## 0.20.1

### Patch Changes

- Updated dependencies [70c30f3]
  - @parity/product-sdk-host@0.15.1
  - @parity/product-sdk-chain-client@0.9.3
  - @parity/product-sdk-cloud-storage@0.9.1
  - @parity/product-sdk-local-storage@0.3.4
  - @parity/product-sdk-signer@0.12.1
  - @parity/product-sdk-keys@0.3.18
  - @parity/product-sdk-contracts@0.10.1
  - @parity/product-sdk-tx@0.4.1

## 0.20.0

### Minor Changes

- bffc04a: Typed `AllowanceExpiredError` for signs that fail on a lapsed allowance.

  New `AllowanceExpiredError` in `@parity/product-sdk-signer` (extends
  `SignerError`, so it carries the shared `SdkError` marker; `.resource` names
  the lapsed allowance, `.cause` holds the underlying failure). The terminal
  session signers (`signTx` via `session.createTransaction`, `signBytes` via
  `session.signRaw`) now reject with it when the failure is the statement-store
  `NoAllowanceError` (matched directly or anywhere on the `cause` chain) instead
  of a generic `Error` — so consumers can `catch (e) { if (e instanceof
AllowanceExpiredError) … }` and prompt a re-pair, rather than string-matching
  console output.

  Deliberately **thrown**, not returned as a `Result` `err`: it surfaces at
  PAPI's `PolkadotSigner.signTx`/`signBytes` boundary, whose contract is a
  rejecting Promise — an intentional exception to the SDK-wide Result
  convention. Re-exported from `@parity/product-sdk-terminal` (which gains a
  `@parity/product-sdk-signer` workspace dependency).

  Note: the root-cause fix for the 240 s hang before this error is even
  reachable lives upstream in `@novasamatech/host-papp`
  (`awaitReplyOrAckFailure` drops rejected ACKs) and is tracked separately.

- bffc04a: Bulletin allowance status read-back: `getBulletinAllowanceStatus`.

  New `getBulletinAllowanceStatus(api, slotAddress)` returns
  `Result<BulletinAllowanceStatus, CloudStorageAuthorizationError>`, composing
  the existing `checkAuthorization` quota read with a `System.Number`
  current-block read. `BulletinAllowanceStatus extends AuthorizationStatus` with
  the two derived fields every consumer re-computes by hand:
  `remainingBlocks` (`max(0, expiration - currentBlock)`) and `usable`.

  `usable` folds in every hard gate the chain enforces: the authorization must
  exist, be unexpired (`currentBlock < expiration`), **and** have quota left
  (`remainingTransactions > 0` and `remainingBytes > 0`). Expiry is not the only
  gate — the chain also rejects a store once the transaction or byte quota is
  exhausted. `usable === true` still does not guarantee a given store will fit:
  callers must size-check `remainingBytes` against their actual payload.

  Errors from either on-chain read propagate on the `err` channel.

- bffc04a: Export the pallet-revive account-mapping read probe.

  New `isContractAccountMapped(runtime, address)` returns
  `Result<boolean, ContractError>` — the read-only half of
  `ensureContractAccountMapped`, extracted from its inline checker. It derives
  the H160 via `ss58ToH160` and reads `Revive.OriginalAccount`; no signer, no
  transaction, no wallet prompt, so it's safe for "is this account ready to make
  contract calls?" checks. `ensureContractAccountMapped` now reuses it
  internally (a failed probe still surfaces as `TxAccountMappingError`, with the
  `ContractError` attached on the cause chain).

- bffc04a: Validate the dry-run/tx origin before it reaches PAPI's `AccountId` codec.

  A non-SS58 origin — most commonly the account's H160 (`0x…`), since
  pallet-revive derives the H160 `msg.sender` _from_ the SS58 origin — used to
  fail deep inside the encode stack as a bare `Invalid checksum` with no hint
  about the cause. All three call paths now validate the resolved origin with
  `isValidSs58` and produce a new `ContractInvalidOriginError extends
ContractError` (message includes the rejected value, plus a "looks like an
  H160 — convert it with `h160ToSs58`" hint when applicable):

  - `.tx()` and `.prepare()` return it as `err(ContractInvalidOriginError)`;
  - `.query()` **throws** it (`QueryResult` has no error channel — the one
    deliberate asymmetry).

  Validation only — no auto-conversion, so the SDK never silently changes which
  account the caller believes is calling.

- bffc04a: **Degrade gracefully when resolving a product account while signed out (#253).**

  When `HostProvider` is configured with `productAccount` and `connect()` runs
  without an active user session, the signed-out (`NotConnected`) state was
  treated as a fault: logged at `error` level with an opaque `{ cause }` payload
  (which serialized to `{}`), and retried up to 3× by `connect()`. It now
  soft-degrades to an empty accounts list (read-only), mirroring the `dappName`
  branch — signed-out and unregistered-identifier (`DomainNotValid`) failures log
  at `debug`/`warn` and skip retries, while genuine transient faults still error
  and retry.

  All host-RPC error logs in `host.ts` now serialize a readable message
  (`{ error: <message> }`) instead of the opaque `{ cause }`, so structured log
  sinks show the actual reason. `HostRejectedError` gains a `nonTransient` flag
  carrying the classification.

- bffc04a: Allow the `-terminal/host` allocation APIs to target an explicit `productId`.

  `requestResourceAllocation` (via `options.productId`), `getCachedAllocation`,
  `ensureSlotAccountSigner`, and `createSlotAccountSigner` (via a trailing
  optional `productId` parameter) can now override `adapter.appId` for both the
  wire `callingProductId` and the slot-cache namespace. Defaults to
  `adapter.appId` — no behavior change for existing callers.

  Fixes the PGAS mis-mapping footgun where an app whose product id differs from
  the terminal's storage `appId` gets its sponsored-gas allowance minted and
  auto-mapped on the wrong on-chain account, and brings the allocation side in
  line with the signer/read side (`createSessionSignerForAccount`,
  `getBulletinSigner`), which already takes an explicit `productId`. Consumers
  can delete their `{ ...adapter, appId: productId }` spread workarounds.

  > **Warning:** thread the **same** `productId` through **all four** allocation
  > APIs — `requestResourceAllocation`, `getCachedAllocation`,
  > `ensureSlotAccountSigner`, and `createSlotAccountSigner`. Deleting the
  > `{ ...adapter, appId }` spread without passing `productId` everywhere silently
  > reintroduces the wrong-account PGAS mint (allowance minted / auto-mapped on
  > the account derived from `adapter.appId` instead of your product's account),
  > which is exactly the footgun this change closes.

- bffc04a: Update `@parity/truapi` to 0.6.0. Product-account derivation indexes are now
  tagged `DerivationIndex` selectors on the wire (`{ tag: "Left", value: number }`
  for a plain index, `{ tag: "Right", value: <32-byte hex> }` for a raw index).
  The ergonomic account surfaces keep plain numbers — `getProductAccount(id,
index)` and `ProductAccount.derivationIndex` are unchanged, with the host
  adapter wrapping them as `Left` — but the pass-through shapes track the
  protocol: `ProductProofContext.suffix` (ring VRF contexts, exported from both
  host and signer) is now the tagged selector instead of a hex string, and
  `PaymentTopUpSource`'s `ProductAccount` source and `AllocatableResource`'s
  `SmartContractAllowance` value carry it too. The
  `DerivationIndex` type is exported from host and signer. The release also
  brings the host's new sr25519 `account.signVrf` API (not yet wrapped by an SDK
  accessor).
- bffc04a: Stop collapsing pre-inclusion transaction failures to opaque errors.

  New `TxValidityError` (extends `TxError`; raw failure payload on `.reason`,
  human-readable `.formatted`): `submitAndWatch` now puts it on the `err`
  channel for _pre-inclusion_ validity/submission failures: polkadot-api
  rejects the subscription with an `InvalidTxError` whose `.error` carries the
  decoded `TransactionValidityError` — e.g. `InvalidTransaction::Payment` when
  the submitter can't pay or isn't authorized. The payload is preserved on
  `.reason` and formatted via the new `formatValidityError` helper
  (`{ type: "Invalid", value: { type: "Payment" } }` → `"Invalid.Payment"`).
  Previously this surfaced as a base `TxError` whose message was raw JSON.

  An _included_ failure event that carries no `dispatchError` — an anomaly,
  since `dispatchError` normally exists once a tx is included — is classified
  as a `TxDispatchError` with a neutral message, no longer the placeholder
  `"unknown error"`. It is deliberately **not** a `TxValidityError`: that type
  is reserved for genuine pre-inclusion failures, and this case is
  post-inclusion.

  `formatValidityError(reason)` is exported alongside the other formatters.

  `withRetry` treats `TxValidityError` as non-retryable, matching how these
  failures behaved when they surfaced as `TxDispatchError`.

### Patch Changes

- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
- Updated dependencies [bffc04a]
  - @parity/product-sdk-signer@0.12.0
  - @parity/product-sdk-cloud-storage@0.9.0
  - @parity/product-sdk-contracts@0.10.0
  - @parity/product-sdk-host@0.15.0
  - @parity/product-sdk-tx@0.4.0
  - @parity/product-sdk-chain-client@0.9.2
  - @parity/product-sdk-local-storage@0.3.3
  - @parity/product-sdk-keys@0.3.17

## 0.19.1

### Patch Changes

- Updated dependencies [8ab88ba]
- Updated dependencies [8ab88ba]
  - @parity/product-sdk-signer@0.11.1
  - @parity/product-sdk-host@0.14.1
  - @parity/product-sdk-contracts@0.9.2
  - @parity/product-sdk-chain-client@0.9.1
  - @parity/product-sdk-cloud-storage@0.8.1
  - @parity/product-sdk-local-storage@0.3.2
  - @parity/product-sdk-keys@0.3.16
  - @parity/product-sdk-tx@0.3.2

## 0.19.0

### Minor Changes

- c3fccfa: **Breaking: remove the Summit Network (Web3 Summit) environment.**

  The Summit event is over and its chains are being decommissioned. Removes
  the `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
  descriptors, `"summit"` from `Environment` / `CloudStorageEnvironment`
  (`getChainAPI("summit")` and `CloudStorageClient.create({ environment:
"summit" })` no longer compile), the `CloudStorageNetworks.summit` preset,
  and `BULLETIN_RPCS.summit`. `paseo` and `devnet` are unaffected.

- c3fccfa: **Update `@parity/truapi` to 0.5.0 (versioned call errors, CoinPayment, Ring
  VRF redesign).**

  truapi 0.4 wraps every call error in its canonical `CallErrorValue`
  envelope: domain failures arrive as `{ tag: "Domain", value: { tag: "V1",
value: <domain error> } }`, alongside the transport-level `Denied` /
  `Unsupported` / `MalformedFrame` / `HostFailure` variants. truapi 0.5
  reworks the Ring VRF surface around product-scoped proof contexts. The SDK
  tracks the protocol:

  - `AccountsProvider` lookup methods now carry
    `CallErrorValue<Versioned…Error>` on their `err` channel instead of the
    bare per-domain error unions.
  - `HostErrorPayload` is now the `CallErrorValue` envelope itself
    (protocol-sourced, replacing the previous hand-widened union), and
    `formatHostError` / `HostCallFailedError` messages unwrap the `Domain`
    envelope down to the domain error, so rendered messages read as before.
  - **Ring VRF**: `getProductAccountAlias` and `createRingVRFProof` (on
    `AccountsProvider`, `SignerManager`, and the signer's `HostProvider`)
    now take a `ProductProofContext` (`{ productId, suffix }`) plus the
    restructured `RingLocation` (`{ chainId, junctions }`) — the host
    selects the ring member key, so per-account `dotNsIdentifier` /
    `derivationIndex` addressing is gone. `createRingVRFProof` returns a
    `RingVRFProof` (`{ proof, contextualAlias, ringIndex, ringRevision }`)
    instead of bare proof bytes, carrying the values needed to verify the
    proof downstream.
  - `PaymentManager` purse parameters follow truapi's rename of
    `PaymentPurseId` to `CoinPaymentPurseId` (same underlying type).
  - The `createFakeTruApiClient` test fake covers the new `coinPayment`
    domain as an unmodeled (throwing) surface and the richer Ring VRF proof
    response.

### Patch Changes

- Updated dependencies [c3fccfa]
- Updated dependencies [c3fccfa]
  - @parity/product-sdk-host@0.14.0
  - @parity/product-sdk-cloud-storage@0.8.0
  - @parity/product-sdk-chain-client@0.9.0
  - @parity/product-sdk-signer@0.11.0
  - @parity/product-sdk-local-storage@0.3.1
  - @parity/product-sdk-contracts@0.9.1
  - @parity/product-sdk-keys@0.3.15
  - @parity/product-sdk-tx@0.3.1

## 0.18.0

### Minor Changes

- cb0098f: **Add `devnet` — the public Paseo-testnet products devnet — as a new environment.**

  Adds `devnet-asset-hub`, `devnet-bulletin`, and `devnet-individuality` (the
  People chain) descriptors, generated against the community-run Paseo system
  chains (Asset Hub 1000, People 1004, Bulletin 1010), and wires `devnet`
  through the host Bulletin RPC list, the cloud-storage network preset, and
  `getChainAPI("devnet")`. Unlike `paseo` — which targets the Paseo Next v2
  deployment — `devnet` targets the long-lived public Paseo testnet. Purely
  additive — no existing environment, descriptor, or endpoint changes.

- cb0098f: Introduce an SDK-wide `Result` error model: fallible operations across the
  `@parity/product-sdk-*` packages now return a typed `Result<T, E>` instead of
  throwing, so consumers branch on `r.ok` and get typed errors on the `err`
  channel. See the `guides/migrating-to-result` migration guide.

  **New package — `@parity/result`:** a generic, domain-agnostic, zero-dependency
  leaf exporting `Result<T, E>` (`{ ok: true; value } | { ok: false; error }`),
  `ok()` / `err()`, `normalizeError(cause, ErrorClass)` (coerce a caught value to a
  typed error — the single error-normalization strategy, replacing ad-hoc `as`
  casts), `isErrorOf(e, ErrorClass)` (generic `instanceof` guard), and
  `unwrapOk` / `unwrapErr` (framework-agnostic test/script assertions). It carries
  no product-sdk specifics, so it can be embedded anywhere.

  **New package — `@parity/product-sdk-errors`:** a zero-dependency leaf holding
  the product-sdk-specific cross-package `SdkError` marker interface +
  `isSdkError(e)` guard. Every package's base error implements the marker (with a
  `source` string like `"tx"`), so `isSdkError(e)` recognizes any SDK-origin error
  without importing per-package classes. `@parity/product-sdk` re-exports `Result` /
  `ok` / `err` / `isErrorOf` from `@parity/result` and `SdkError` / `isSdkError`
  from `@parity/product-sdk-errors`.

  **Breaking — these now return `Result` instead of throwing:**

  - `@parity/product-sdk-tx`: `submitAndWatch`, `batchSubmitAndWatch` → `Result<TxResult, TxError>`; `ensureAccountMapped` → `Result<TxResult | null, TxError>` (`ok(null)` = already mapped); `extractTransaction` → `Result<SubmittableTransaction, TxDryRunError>` (sync). `TxAccountMappingError` now extends `TxError`.
  - `@parity/product-sdk-contracts`: `contract.<method>.tx` → `Result<TxResult, ContractError | TxError>`; `.prepare` → `Result<BatchableCall, ContractError>`; `withLiveContractAddresses` and `ContractManager.fromLive` / `fromLiveClient` → `Result<…, ContractError>`; `ensureContractAccountMapped` → `Result<TxResult | null, TxError>`. **`contract.<method>.query` is unchanged** — it keeps returning `QueryResult<T>`, since a dry-run revert is an expected outcome (a value), not an error.
  - `@parity/product-sdk-cloud-storage`: `queryBytes`, `queryJson`, `executeQuery`, `checkAuthorization`, `verifyStored` (`ok(null)` = not recorded at that block), `authorizeAccount`, and the equivalent `CloudStorageClient` read methods (`fetchBytes` / `fetchJson` / `checkAuthorization` / `verifyStored`). The `CloudStorageClient` methods that forward to the upstream client (`store`, `authorizePreimage`, `renew`, `estimateAuthorization`, and the `authorizeAccount` _method_) are unchanged.
  - `@parity/product-sdk-statement-store`: `StatementStoreClient.publish` and `ChannelStore.write` → `Result<void, StatementStoreError>` (were `Promise<boolean>`). The old boolean swallowed the failure reason into `false`; the `Result` now carries it (`StatementConnectionError`, `StatementDataTooLargeError`, `StatementSubmitError`). **Note:** a bare `if (result)` now always passes (a `Result` object is truthy) — audit call sites for `.ok`.
  - `@parity/product-sdk` umbrella: `createApp().cloudStorage.upload` / `fetch` now return `Result` (`computeCid` unchanged — pure).

  `@parity/product-sdk-host` and `@parity/product-sdk-signer` (whose public
  operations already returned `Result`) migrate onto the shared `@parity/result`
  package and adopt the `SdkError` marker from `@parity/product-sdk-errors`; no
  further API change.

  **Unchanged everywhere:** pure/sync helpers and factories, build-time codegen,
  lifecycle methods, and subscription APIs continue to throw or return their
  existing types — `Result` is reserved for fallible runtime operations.

- cb0098f: **Ship dev-only test fakes under a new `/testing` subpath on each package.**

  Each package now exports a working in-memory fake of its interface from a
  dedicated `/testing` entry, so SDK-dependent app code can be unit-tested with no
  host container, chain, or wallet:

  - `@parity/product-sdk-local-storage/testing` — `createFakeHostLocalStorage`
  - `@parity/product-sdk-signer/testing` — `createFakeSignerProvider`, `fakeSignerAccount`
  - `@parity/product-sdk-statement-store/testing` — `createFakeStatementTransport`
  - `@parity/product-sdk-contracts/testing` — `createFakeContractRuntime`, `fakeDryRunResult`
  - `@parity/product-sdk-host/testing` — `createFakeTruApiClient`, `createFakeHost`, `setTruApiClient`
  - `@parity/product-sdk/testing` — `createFakeApp`, plus re-exports of the
    local-storage, signer, contracts, and host fakes

  The fakes are framework-agnostic, live behind separate build entries, and are
  absent from every package's main entry, so production bundles are unaffected.
  `@parity/product-sdk-host` additionally gains a module-level test seam
  (`setTruApiClient`, exposed only through `/testing`) that the host accessors
  consult before the sandbox client; it defaults to `null`, so production
  behavior is unchanged.

  See the new "Testing your app" guide in the docs for usage.

### Patch Changes

- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
- Updated dependencies [cb0098f]
  - @parity/product-sdk-host@0.13.0
  - @parity/product-sdk-cloud-storage@0.7.0
  - @parity/product-sdk-chain-client@0.8.0
  - @parity/result@0.2.0
  - @parity/product-sdk-errors@0.2.0
  - @parity/product-sdk-tx@0.3.0
  - @parity/product-sdk-contracts@0.9.0
  - @parity/product-sdk-signer@0.10.0
  - @parity/product-sdk-local-storage@0.3.0
  - @parity/product-sdk-keys@0.3.14

## 0.17.0

### Minor Changes

- f81fc2b: Move the throw→`Result` boundary into `@parity/product-sdk-host`: the flat public host operations now return a tagged `Result<T, HostError>` instead of throwing opaque `Error`s, so every consumer gets typed errors (not just the signer, which previously wrapped host's throws in its own `try/catch`).

  **New exports (`@parity/product-sdk-host`):**

  - `Result<T, E>` (`{ ok: true; value } | { ok: false; error }`) plus `ok()` / `err()` constructors. The shape is intentionally identical to `@parity/product-sdk-signer`'s `Result`, so the two layers compose with no adapter.
  - A `HostError` class hierarchy — `HostError` (base, extends `Error`), `HostUnavailableError` (raised when running outside a host container), and `HostCallFailedError` (a host call reached the container but failed; carries the structured truapi error as `.payload` and as `cause`) — plus an `isHostError(e)` type guard. The hierarchy mirrors the signer's error classes, so `instanceof HostUnavailableError` works across both layers.

  **Breaking (shape) changes — minor-bumped because the package is pre-1.0:**

  - These functions now return `Promise<Result<T, HostError>>` instead of throwing: `requestPermission`, `requestDevicePermission`, `requestResourceAllocation`, `createProofAuthorized`, `deriveEntropy`, `navigateTo`, `broadcastTransaction`, `stopTransaction`, `featureSupported`, `isChainSupported`. Migrate `const x = await foo()` (which threw on failure) to `const r = await foo(); if (!r.ok) handle(r.error); const x = r.value`.
  - `getChainSpec` now returns `Promise<Result<ChainSpec | null, HostError>>`. `ok(null)` still means "running outside a host container" (an expected state, not a failure); a real host-call failure now surfaces on the `err` channel instead of throwing. Migrate `const spec = await getChainSpec(h); if (spec) …` to `const r = await getChainSpec(h); if (r.ok && r.value) …`.
  - The exported error-payload type **`HostError` is renamed to `HostErrorPayload`** (the structured truapi `Err`-channel shape), freeing the name `HostError` for the new base error class. The payload now rides inside `HostCallFailedError.payload`.

  **Unchanged:**

  - The feature-detection getters that return `T | null` (`getThemeProvider`, `getAccountsProvider`, `getHostProvider`, `getHostLocalStorage` / `createHostLocalStorage`, `getStatementStore`, `getPreimageManager` / `createHostPreimageManager`, `getChatManager`, `getNotificationManager`, `getPaymentManager`) keep their `T | null` signatures. Their throwing lives in the methods of the adapter objects they return — some of which implement external interfaces (e.g. polkadot-api's `JsonRpcProvider`) whose signatures can't carry a `Result` — so those methods keep the throw convention via the retained internal `unwrapHostResult` helper.

  **`@parity/product-sdk-signer` (patch):** internal only — the public API is unchanged. `HostProvider`'s default `requestChainSubmitPermissionFn` and `SignerManager`'s `ConnectContext.requestResourceAllocation` now adapt host's `Result`-returning functions back to their existing `Promise<boolean>` / `Promise<AllocationOutcome[]>` contracts (unwrap-or-throw at the boundary), so consumer callbacks see no change.

- f81fc2b: Migrate `@parity/product-sdk-host`'s host-API surface — plus the statement store, preimage, and the signer's host provider — from the third-party `@novasamatech` packages to the in-house `@parity/truapi` client, and drop `@novasamatech/sdk-statement` from `@parity/product-sdk-statement-store`.

  A new sandbox-bootstrap module detects the host environment (iframe / webview / injected message port), builds the `@parity/truapi` transport, creates the client, and runs the `system.handshake` — replacing the wrapper's auto-detected `hostApi` singleton. `@parity/truapi` is now a hard runtime dependency of `host` (alongside `neverthrow`, `@polkadot-api/json-rpc-provider`, and `@polkadot-api/substrate-bindings`). With the accounts/signer surface migrated, **nothing in `host` or `signer` imports `@novasamatech/host-api-wrapper` / `host-api` at runtime anymore.**

  **Migrated to `@parity/truapi`:** `getTruApi`, `requestResourceAllocation`, `requestPermission`, `requestDevicePermission`, `deriveEntropy`, `getHostLocalStorage` / `createHostLocalStorage` (adapted onto `localStorage.read/write/clear`), `isInsideContainer` / `isInsideContainerSync`, `getStatementStore` + `createProofAuthorized` (`statementStore.*`), `getPreimageManager` / `createHostPreimageManager` (`preimage.*`), `getThemeProvider` (`theme.*`), `getChatManager` (`chat.*`), `getPaymentManager` (`payment.*`), `getNotificationManager` (`notifications.*`), `navigateTo` (`system.navigateTo`), `featureSupported` / `isChainSupported` (`system.featureSupported`), `getChainSpec` (`chain.getSpec*`), `broadcastTransaction` / `stopTransaction` (`chain.*`), `getHostProvider` (the PAPI `JsonRpcProvider`, over `chain.*` + `system.featureSupported`), and `getAccountsProvider` (over `account.*` + `signing.*`).

  The `getNotificationManager`, `navigateTo`, `featureSupported` / `isChainSupported`, `getChainSpec`, and `broadcastTransaction` / `stopTransaction` wrappers were re-pointed from the flat novasama `hostApi` onto the namespaced truapi client (`system.*` / `chain.*` / `notifications.*`); their public Promise-shaped signatures are unchanged. `PushNotificationError` is now the `@parity/truapi` `{ tag }` tagged union (`"ScheduleLimitReached"` / `"Unknown"`) rather than a SCALE codec — branch on `(err as Error).cause` (the rejected `Error` carries the host error as its `cause`) instead of `instanceof`.

  The PAPI provider is built by a new `papi-provider` module — a backport of `@novasamatech/host-api-wrapper`'s `createPapiProvider` into product-sdk, with the per-method calls re-pointed at `truApi.chain.*`. It bridges PAPI's JSON-RPC `chainHead` / `chainSpec` / `transaction` API to the host's structured calls (request dispatch, `chainHead_v1_followEvent` synthesis, synthetic follow-subscription ids, operation/broadcast bookkeeping). Unlike the upstream it needs no `getSyncProvider` deferral or no-op fallback: `getHostProvider` is async and runs the chain-support gate (throwing `ChainNotSupportedError`) before the provider is built. `getHostProvider`'s signature and `ChainNotSupportedError` behavior are unchanged.

  **Accounts + signer.** `getAccountsProvider` moves to a new `accounts` module — a backport of the wrapper's `createAccountsProvider`, with lookups/proofs re-pointed onto `truApi.account.*` and the `PolkadotSigner` factories (`getProductAccountSigner` / `getLegacyAccountSigner`) built over `truApi.signing.*`. The account types (`HostAccount`, `ProductAccount`, `ContextualAlias`, `AccountsProvider`, plus a re-exported `RingLocation`) now live in `accounts` and are derived from / re-exported alongside `@parity/truapi`. The provider's public method surface and the `PolkadotSigner` behavior (metadata-driven `txExtVersion`, signed-extension mapping, the `createTransaction` vs deprecated `signPayload` modes) are preserved.

  `@parity/product-sdk-signer`'s `HostProvider` now consumes `host`'s `getAccountsProvider` instead of dynamically importing the wrapper, and requests the `ChainSubmit` permission via `host`'s `requestPermission` (`truApi.permissions`, plain `{ tag }` shapes) — so the wrapper-shaped loader indirection (`loadSdk` / `loadHostApiEnum` / the `host-api` `RemotePermission` enum constructors) is gone. `HostProviderOptions` swaps the internal `loadSdk` / `loadHostApiEnum` hooks for `loadAccountsProvider` / `requestChainSubmitPermissionFn`; the public `connect()` / account / signer behavior is unchanged.

  **Still on `@novasamatech/host-api-wrapper`:** nothing in `host` / `signer`. (The `terminal` package's separate `@novasamatech/host-papp` / `statement-store` / `storage-adapter` deps are out of scope.)

  **Removed:** chat custom-message rendering — `matchChatCustomRenderers`, `getChatManager().onCustomMessageRenderingRequest`, and the `ChatCustomMessageRenderer` / `ChatCustomMessageRendererParams` types. `@parity/truapi` models custom render as a different, currently-stubbed client subscription with no product-as-renderer primitive; this will be reintroduced when that flow lands. The chat / theme / payment types (`ChatRoom`, `ChatMessageContent`, `ChatReceivedAction`, `ChatRoomRegistrationResult` / `ChatBotRegistrationResult`, `ThemeMode` / `ThemeName` / `ThemeVariant`, `PaymentBalance`, `PaymentStatus`, `TopUpSource`) are now re-exported from `@parity/truapi` — proofs/statuses use `{ tag }`, and `PaymentStatus` / `TopUpSource` follow the truapi shapes.

  **`@parity/product-sdk-host` breaking (shape) changes** — minor-bumped because the package is pre-1.0:

  - **`TruApi` / `getTruApi()`** now resolve to the namespaced `@parity/truapi` `TrUApiClient` instead of the flat novasama `hostApi`. Direct callers move from e.g. `truApi.permission(enumValue("v1", p))` to `truApi.permissions.requestRemotePermission({ permission: p })`, and `truApi.navigateTo(url)` to `truApi.system.navigateTo({ url })`.
  - **`AllocationOutcome`** is now the string union `"Allocated" | "Rejected" | "NotAvailable"` (previously a tagged enum). Inspect with `outcome === "Allocated"` rather than `outcome.tag === "Allocated"`.
  - **`AllocatableResource`, `RemotePermission`, `DevicePermissionKind`** are derived from `@parity/truapi` types; variant tags are unchanged, except `DevicePermissionKind` is now a string union (`"Camera"`, `"Microphone"`, …).
  - **`HostLocalStorage`** is now an explicit interface (`readString` / `writeString` / `readJSON` / `writeJSON` / `readBytes` / `writeBytes` / `clear`); method signatures unchanged.
  - **Statement types** (`Statement`, `SignedStatement`, `StatementProof`, `Topic`, `ProductAccountId`, `StatementTopicFilter`, `StatementsPage`) are re-exported from `@parity/truapi`: fields are `0x`-prefixed `HexString`s, proofs use `{ tag: "Sr25519" }`, and `ProductAccountId` is `{ dotNsIdentifier, derivationIndex }`. `HostStatementStore` exposes `subscribe` / `createProofAuthorized` / `submit`. `HostSubscription` is an explicit `{ unsubscribe; onInterrupt }` interface.
  - New exported helper **`unwrapHostResult(result, label)`** collapses the repeated `ResultAsync.match(ok, err ⇒ throw)` pattern across the host wrappers.

  Host-error formatting (`formatHostError`) now reads `@parity/truapi`'s error shapes (`GenericError`'s `reason`, tagged-variant reasons, unit tags) while still unwrapping the legacy novasama envelope for the surfaces on the wrapper.

  **`@parity/product-sdk-statement-store`:**

  - Drops the `@novasamatech/sdk-statement` dependency and the `@novasamatech/host-api-wrapper` peer/dev dependency.
  - The statement value types are now **derived** from the `@parity/truapi` wire types (`Statement = Omit<WireStatement, "data"> & { data?: Uint8Array }`), so protocol changes propagate automatically; `Proof` / `Topic` are re-exported verbatim. The only intentional difference is `data` (decoded `Uint8Array` vs the wire hex string). `createExpiry` and the ergonomic `TopicFilter` (`"any" | matchAll | matchAny`) remain local; the unused `SubmitResult` type is removed.
  - **Behavior change:** host-mode submission now uses the RFC-10 sponsored path (`createProofAuthorized`) — statements are signed by the product's allowance account rather than a per-call account. The host-mode `accountId` credential is no longer used (now optional, ignored if supplied).

  Submitted statements are unchanged on the wire; only the TypeScript surface and the signing account change. No consumer code changes are required beyond dropping any direct `@novasamatech/sdk-statement` imports in favor of `@parity/product-sdk-statement-store`.

- f81fc2b: Remove the last PolkadotJS (`polkadot-api/pjs-signer`) dependency from the host account signer factories. `getLegacyAccountSigner` now builds a PAPI `PolkadotSigner` directly over `truApi.signing.createTransactionWithLegacyAccount` / `signRawWithLegacyAccount`, mirroring the product-account `createTransaction` path, so opaque signed extensions (e.g. Paseo Next's `AsPgas`) survive end-to-end for legacy accounts too.

  `getProductAccountSigner` drops its `signerType` parameter — the deprecated `"signPayload"` (PJS-bridge) mode is gone; product-account signing always uses the host's `createTransaction` path. The signer's `HostProvider` no longer passes a signer type.

### Patch Changes

- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
- Updated dependencies [f81fc2b]
  - @parity/product-sdk-host@0.12.0
  - @parity/product-sdk-signer@0.9.0
  - @parity/product-sdk-chain-client@0.7.7
  - @parity/product-sdk-cloud-storage@0.6.7
  - @parity/product-sdk-local-storage@0.2.12
  - @parity/product-sdk-contracts@0.8.3
  - @parity/product-sdk-keys@0.3.13
  - @parity/product-sdk-tx@0.2.17

## 0.16.0

### Minor Changes

- ef14a41: **Add typed wrappers for the host's navigation, feature-probe, chain-spec, and transaction-broadcast TruAPI calls.**

  These raw `hostApi.*` methods previously required `getTruApi()` plus a manual `enumValue("v1", ...)` wrap and neverthrow `ResultAsync` unwrap. They now have thin, fully-typed wrappers in `@parity/product-sdk-host` (re-exported from `@parity/product-sdk/host`), matching the throw-on-error / return-null conventions of the existing `requestPermission`, `deriveEntropy`, and `getThemeProvider` helpers.

  ### New public API

  - `navigateTo(url: string): Promise<void>` — deep-link / external navigation. Throws on `NavigateToErr::PermissionDenied` / `::Unknown`.
  - `featureSupported(feature: Feature): Promise<boolean>` and `isChainSupported(genesisHash: HexString): Promise<boolean>` — probe host feature/chain support. `Feature` is `{ tag: "Chain"; value: HexString }`.
  - `getChainSpec(genesisHash: HexString): Promise<ChainSpec | null>` — fetches genesis hash, chain name, and properties in one concurrent call. Returns `null` outside a container. `ChainSpec` carries `{ genesisHash, name, properties: ChainProperties | null, propertiesRaw: string }`; `properties` is the host's properties JSON parsed into `{ ss58Format?, tokenDecimals?, tokenSymbol?, [k]: unknown }`, with `propertiesRaw` preserving the original string (and `properties === null` when the JSON can't be parsed).
  - `broadcastTransaction(genesisHash: HexString, transaction: HexString): Promise<string | null>` — broadcast a signed tx; resolves to the operation id (or `null`).
  - `stopTransaction(genesisHash: HexString, operationId: string): Promise<void>` — stop an in-flight broadcast.

  All wrappers throw `"<fn>: TruAPI unavailable"` when running outside a host container, except `getChainSpec`, which returns `null` to match the sibling `get*` getters.

### Patch Changes

- Updated dependencies [ef14a41]
  - @parity/product-sdk-host@0.11.0
  - @parity/product-sdk-chain-client@0.7.6
  - @parity/product-sdk-cloud-storage@0.6.6
  - @parity/product-sdk-local-storage@0.2.11
  - @parity/product-sdk-signer@0.8.3
  - @parity/product-sdk-keys@0.3.12
  - @parity/product-sdk-contracts@0.8.2
  - @parity/product-sdk-tx@0.2.16

## 0.15.1

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
  - @parity/product-sdk-chain-client@0.7.5
  - @parity/product-sdk-cloud-storage@0.6.5
  - @parity/product-sdk-contracts@0.8.1
  - @parity/product-sdk-host@0.10.3
  - @parity/product-sdk-keys@0.3.11
  - @parity/product-sdk-signer@0.8.2
  - @parity/product-sdk-tx@0.2.15
  - @parity/product-sdk-local-storage@0.2.10

## 0.15.0

### Minor Changes

- 0ce53f6: **Export `QUERY_FALLBACK_ORIGIN` — pallet-revive's keyless account used as the read-only query origin.**

  Other products (e.g. the playground CLI) pass an explicit `defaultOrigin` /
  `registryOrigin` for read-only registry dry-runs and were re-deriving
  pallet-revive's account (`PalletId(*b"py/reviv").into_account_truncating()` =
  `5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV`) by mirroring the byte
  derivation. The SDK already computes this internally as its read-only fallback
  origin; it is now exported so consumers can import it instead of duplicating
  the derivation:

  ```ts
  import { QUERY_FALLBACK_ORIGIN } from "@parity/product-sdk-contracts";
  ```

  No behaviour change — only a new export.

### Patch Changes

- Updated dependencies [0ce53f6]
  - @parity/product-sdk-contracts@0.8.0

## 0.14.1

### Patch Changes

- c39332e: **`SignerManager.connect("host")` now derives a product account from `dappName` instead of calling the host's legacy-account enumeration.**

  On Proof-of-Personhood / product-account hosts (Polkadot Desktop today, Polkadot Mobile going forward), `accounts.getLegacyAccounts()` is hard-coded to return `[]` by design — the host exposes only per-dapp product accounts via enumeration and never the user's identity account. Pre-this-PR, calling `app.wallet.connect()` on such hosts surfaced `NoAccountsError`, which made the simplest possible "connect a wallet" flow unusable.

  ### What changed

  `HostProvider.tryConnect()`:

  - The legacy-fetch branch (`provider.getLegacyAccounts()` → `mapAccounts(...)` → `NoAccountsError` on empty) is replaced with a derivation branch (`fetchProductSignerAccount(dappName + ".dot", 0)`).
  - When `dappName` is not set, OR the host rejects the derivation (typically because the dotNS identifier isn't registered for this user), `connect()` resolves with `ok([])` rather than throwing. Consumers can still drive the explicit signing paths (`wallet.signMessageWithDotNsIdentity`, `accounts.getLegacyAccountSigner`).
  - `HostProviderOptions` gains a `dappName?: string` field, wired through automatically from `SignerManager` (consumers don't pass it directly).
  - The `AccountsProvider` interface drops the now-unused `getLegacyAccounts` field. `getLegacyAccountSigner` is **kept** — it's the load-bearing primitive for explicit-name signing (used by `wallet.signMessageWithDotNsIdentity`).

  ### No public API change

  - `SignerManager` constructor, `connect()`, and all other methods: unchanged.
  - `HostProvider` constructor: unchanged (`dappName` is additive).
  - `app.wallet.connect()` return shape: unchanged (`{ accounts: Account[] }`).
  - `getLegacyAccountSigner`, `getProductAccount`, `getProductAccountAlias`, `getUserId`, `createRingVRFProof`, `subscribeAccountConnectionStatus`: unchanged.

  ### Behavioral note for consumers

  Anyone catching `NoAccountsError` to gate UI on Polkadot Desktop will see the error go away — `connect()` now resolves with one product-derived account (when the host can derive it) or an empty list (when it can't). Most consumers handle empty arrays gracefully; if you guarded on `NoAccountsError` specifically, switch to checking `accounts.length === 0`.

  The `dappName` you pass to `createApp({ name })` or `new SignerManager({ dappName })` is now also the dotNS identifier the host derives the product account from. `.dot` is appended automatically if missing. If your `dappName` isn't a valid registered dotNS identifier, the host will reject the derivation and `connect()` will resolve with `[]` — usable for explicit-name signing flows but no enumerated account.

- Updated dependencies [c39332e]
- Updated dependencies [c39332e]
  - @parity/product-sdk-host@0.10.2
  - @parity/product-sdk-signer@0.8.1
  - @parity/product-sdk-chain-client@0.7.4
  - @parity/product-sdk-cloud-storage@0.6.4
  - @parity/product-sdk-local-storage@0.2.9
  - @parity/product-sdk-contracts@0.7.7
  - @parity/product-sdk-keys@0.3.10
  - @parity/product-sdk-tx@0.2.14

## 0.14.0

### Minor Changes

- 9ce5ab2: **Sign messages with the account that owns a People / People Lite DotNS username, plus a catalog bump to `@novasamatech/host-api` 0.8.8.**

  ### `@parity/product-sdk` — `wallet.signMessageWithDotNsIdentity`

  - `wallet.signMessageWithDotNsIdentity({ peopleChain, username?, message })` — resolves `Resources.UsernameOwnerOf` on the supplied People / Individuality chain descriptor, then signs the message with that account through the host's legacy-account signing path. Returns `{ username, accountId, signature }`.
  - A matching `useWallet` action surfaces the same call from React.
  - Falls back to the host's primary DotNS username when none is supplied (via the host's `accounts.getUserId()` — triggers a host identity-permission prompt).

  **Implementation note (worth knowing for consumers).** The owning account is named explicitly via the host's `getLegacyAccountSigner({ publicKey })` rather than matched against an enumerated wallet list. On Proof-of-Personhood / product-account hosts (e.g. Polkadot Desktop), the connected-accounts list returned by `getLegacyAccounts()` is intentionally empty — the host exposes only per-dapp product accounts via enumeration and never surfaces the user's identity account. Such hosts still sign with that account when it's _named explicitly_ (typically behind a user-approval prompt), and that's the path this flow uses.

  **Chain-connection lifecycle is automatic.** The SDK reuses an existing chain client when `app.chain.connect({ ..., <name>: peopleChain })` was called upfront (matched by genesis), and falls back to opening a transient connection otherwise. For long-running apps, call `app.chain.connect` once at startup to avoid the cold-path cost.

  ### `@parity/product-sdk-signer` — `SignerManager.getUserId()`

  `SignerManager.getUserId()` wraps the existing `HostProvider.getUserId()` for callers that want to fetch the host primary username without going through a product-account-derivation flow. Returns `HostUnavailableError` when not connected via host, `DestroyedError` after `destroy()`.

  ### Catalog bump — `@novasamatech/host-api` family `^0.8.7` → `^0.8.8`

  `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` move from `^0.8.7` to `^0.8.8`. The headline from upstream is the **legacy sign-request protocol** (PR #218): new `signRawLegacy` / `createTransactionLegacy` UserSession methods plus the matching SCALE codecs (`SignRawLegacyRequest`/`Response`, `CreateTransactionLegacyRequest`, `LegacyTransaction`). This is the protocol scaffolding the new `signMessageWithDotNsIdentity` flow relies on for signing with a wallet's identity account.

  No session/secrets codec changes — `terminal`'s `testing.ts` codec mirror round-trips cleanly against 0.8.8; both interop suites pass.

  ### Example

  ```ts
  import { createApp } from "@parity/product-sdk";
  import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";

  const app = await createApp({ name: "my-app" });

  // Recommended: connect the People chain upfront to share one chainHead
  // subscription across every subsequent identity sign.
  await app.chain.connect({ people: paseo_individuality });

  // No prior `app.wallet.connect()` required — the signing flow names the
  // identity account directly and the host prompts the user to approve.
  //
  // Omit `username` to sign with the host's primary username (the one shown
  // for the currently-logged-in user), or pass it explicitly to sign with a
  // specific People-chain identity the user owns.
  const { username, accountId, signature } =
    await app.wallet.signMessageWithDotNsIdentity({
      peopleChain: paseo_individuality,
      message: "verifying ownership",
    });
  ```

### Patch Changes

- Updated dependencies [9ce5ab2]
  - @parity/product-sdk-signer@0.8.0
  - @parity/product-sdk-host@0.10.1
  - @parity/product-sdk-contracts@0.7.6
  - @parity/product-sdk-chain-client@0.7.3
  - @parity/product-sdk-cloud-storage@0.6.3
  - @parity/product-sdk-local-storage@0.2.8
  - @parity/product-sdk-keys@0.3.9
  - @parity/product-sdk-tx@0.2.13

## 0.13.0

### Minor Changes

- acb2228: **Make `@novasamatech/*` runtime dependencies instead of optional peer dependencies.**

  `@parity/product-sdk-host` now declares `@novasamatech/host-api` and
  `@novasamatech/host-api-wrapper` as regular `dependencies` (via the existing `catalog:`
  range) rather than optional `peerDependencies`. `host-api` was always required at runtime
  — its `enumValue` is statically imported by the published bundle — so the optional-peer
  declaration was incorrect; `host-api-wrapper` is loaded lazily by the host bridge and is
  now pulled transitively too. Consumers can reach the host APIs purely through
  `@parity/product-sdk-host` with no direct `@novasamatech/*` dependency of their own.

- acb2228: **Add `productAccount.requestName` opt-out and a public `HostProvider.getUserId()`.**

  When `HostProviderOptions.productAccount` is set, `connect()` populates
  `SignerAccount.name` from the host primary username via `getUserId()`.
  That host call triggers an identity-permission prompt, which is wasted
  for apps that don't display the name.

  Two additions, both backward-compatible (default behavior unchanged):

  - **`productAccount.requestName`** (default `true`). Set it to `false` to
    skip the `getUserId()` fetch entirely — no name, no prompt — for apps
    with their own display chain (e.g. registry username → fallback).
  - **`HostProvider.getUserId(): Promise<Result<{ primaryUsername }, SignerError>>`**.
    Fetch the name lazily on demand — e.g. on a profile screen — for apps
    that opted out at connect, or that want to react to a `PermissionDenied`
    / `NotConnected` rejection explicitly rather than silently getting a
    nameless account. Mirrors the existing `getProductAccount` /
    `getProductAccountAlias` public methods.

  Existing `productAccount` consumers see no change.

  ```ts
  // Default: name fetched at connect (host identity prompt), as before.
  new HostProvider({ productAccount: { dotNsIdentifier: "myapp.dot" } });

  // Opt out of the connect-time prompt; fetch the name later if needed.
  const provider = new HostProvider({
    productAccount: { dotNsIdentifier: "myapp.dot", requestName: false },
  });
  // ...later, when a screen actually needs the name:
  const result = await provider.getUserId();
  if (result.ok) console.log(result.value.primaryUsername);
  ```

### Patch Changes

- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
- Updated dependencies [acb2228]
  - @parity/product-sdk-host@0.10.0
  - @parity/product-sdk-signer@0.7.0
  - @parity/product-sdk-chain-client@0.7.2
  - @parity/product-sdk-cloud-storage@0.6.2
  - @parity/product-sdk-local-storage@0.2.7
  - @parity/product-sdk-contracts@0.7.5
  - @parity/product-sdk-keys@0.3.8
  - @parity/product-sdk-tx@0.2.12

## 0.12.0

### Minor Changes

- 2124e02: **Bump `@novasamatech/host-api` family from `^0.8.6` to `^0.8.7-2`.** Picks up the upstream `deviceEncPubKey` addition on the V2 session schema (PR #212), the statement-store allowance-slot-prover fix (PR #214 — `createSr25519Prover` → `createSlotAccountProver`), and the `ExpiryTooLow` retry fix in `submitWithRetry`.

  One consumer-visible behavioral change worth flagging up front:

  > **CLI consumers using `@parity/product-sdk-terminal`** — host-papp `0.8.7-1` renamed the on-disk session storage key (`SsoSessionsV2` → `SsoSessionsV3`) and added a required `deviceEncPubKey: Bytes(65)` field on the persisted session. Sessions persisted from a previous CLI run will be invisible after upgrading; users will need to re-pair their phone the first time they launch the upgraded CLI. The `UserSecretsV2_<sessionId>.json` file format is unchanged.

  ### What's new

  **Upstream catalog bump.** `@novasamatech/host-api`, `@novasamatech/host-api-wrapper`, `@novasamatech/host-papp`, `@novasamatech/statement-store`, `@novasamatech/storage-adapter`, and `@novasamatech/substrate-slot-sr25519-wasm` move from `^0.8.6` to `^0.8.7-2`. Headlines from upstream (between `release: 0.8.6 (#208)` and `chore(release): publish 0.8.7-2`):

  - **`deviceEncPubKey` on the V2 session schema** (upstream PR #212). The persisted session codec gains a required `deviceEncPubKey: Bytes(65)` — the paired phone's long-lived ECDH key, lifted from `HandshakeResponseV2.deviceEncPubKey`, used by the host's device-sync channel. The storage key was renamed `SsoSessionsV2 → SsoSessionsV3` in the same release; the old graceful-degrade for V2 blobs is gone.
  - **Statement-store allowance-slot-prover fix** (upstream PR #214). `AllowanceService.getStatementStoreProver` now uses `createSlotAccountProver` instead of `createSr25519Prover` — fixes a signature-scheme mismatch when proving slot-account-derived secrets. No public API change on our side (our `getStatementStoreProver` wrapper passes through unchanged), but the proofs the returned prover emits are now of the correct scheme.
  - **`ExpiryTooLow` retry handling in `submitWithRetry`** (upstream `73cb870`). Internal to host-papp/statement-store retry logic; no consumer-side change.

  ### `@parity/product-sdk-terminal`

  Internal codec mirror used by `createTestSession` updated to match host-papp 0.8.7-2's reshaped session schema:

  - Appended `deviceEncPubKey: Bytes(65)` to the mirrored codec; the synthesized field reuses the remote peer's P-256 encryption pubkey (same value already used for `identityChatPublicKey` and `ssoEncPubKey`).
  - Storage-key rename: `SsoSessionsV2.json` → `SsoSessionsV3.json`. The in-source unit tests and TSDoc references all updated.

  No public-API change; `createTestSession`'s signature is unchanged. The interop test continues to round-trip the synthesized session through the real `SsoSessionManager` and `UserSecretRepository` to catch upstream drift early — both interop suites pass against host-papp 0.8.7-2.

  ### `@parity/product-sdk-host`, `@parity/product-sdk-signer`, `@parity/product-sdk-statement-store`

  Patch-bumped to signal "tested against host-api(-wrapper) 0.8.7-2" via the published peer-dep / catalog resolution. No source change; runtime behavior is unchanged.

  ### Migration

  **`@parity/product-sdk-terminal` — existing sessions need to be re-paired.** No source change required, but any sessions persisted to disk by a previous CLI run will be invisible after upgrading. host-papp 0.8.7-2 reads from `<storageDir>/<appId>_SsoSessionsV3.json`; the previous `SsoSessionsV2.json` path is no longer consulted, and the old graceful-degrade for stale blobs is gone.

  What this means in practice:

  - A user upgrading the CLI will see the same UX they'd see on a fresh install — `waitForSessions` returns no sessions until they complete a QR pairing.
  - The old `SsoSessionsV2.json` file is not deleted, just ignored. Optional cleanup: surface a one-liner to the user ("we updated the session format, please re-pair") and `fs.unlink` the legacy path.
  - The `UserSecretsV2_<sessionId>.json` file format is unchanged; legacy secrets files become orphaned (the new session has a different `sessionId`) but don't cause errors.
  - Synthesized test sessions emitted by `createTestSession` automatically write to the new path — no test code change needed unless your tests asserted on the old filenames.

- 2124e02: **Add a `getNotificationManager()` host wrapper.**

  `getNotificationManager()` returns the host's `notificationManager` singleton
  (`push` / `cancel`), matching the `getPaymentManager` / `getPreimageManager`
  pattern. The module also re-exports `PushNotificationError` (with its
  `ScheduleLimitReached` variant, for `instanceof` branching on the host's
  pending-notification cap) plus the derived `NotificationId` /
  `PushNotificationInput` types.

  Lets consumers reach the host push-notification surface without importing
  `@novasamatech/host-api(-wrapper)` directly.

### Patch Changes

- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
- Updated dependencies [2124e02]
  - @parity/product-sdk-host@0.9.0
  - @parity/product-sdk-signer@0.6.4
  - @parity/product-sdk-cloud-storage@0.6.1
  - @parity/product-sdk-chain-client@0.7.1
  - @parity/product-sdk-local-storage@0.2.6
  - @parity/product-sdk-contracts@0.7.4
  - @parity/product-sdk-keys@0.3.7
  - @parity/product-sdk-tx@0.2.11

## 0.11.0

### Minor Changes

- a2fd276: **Add the Summit Network (Web3 Summit) as a new environment.**

  Adds `summit-asset-hub`, `summit-bulletin`, and `summit-individuality`
  (the People chain) descriptors, and wires `summit` through the host
  Bulletin RPC list, the cloud-storage network preset, and
  `getChainAPI("summit")`. Purely additive — no existing environment,
  descriptor, or endpoint changes.

### Patch Changes

- Updated dependencies [a2fd276]
  - @parity/product-sdk-host@0.8.0
  - @parity/product-sdk-cloud-storage@0.6.0
  - @parity/product-sdk-chain-client@0.7.0
  - @parity/product-sdk-local-storage@0.2.5
  - @parity/product-sdk-signer@0.6.3
  - @parity/product-sdk-keys@0.3.6
  - @parity/product-sdk-contracts@0.7.3
  - @parity/product-sdk-tx@0.2.10

## 0.10.1

### Patch Changes

- Updated dependencies [d4bc935]
  - @parity/product-sdk-host@0.7.1
  - @parity/product-sdk-signer@0.6.2
  - @parity/product-sdk-chain-client@0.6.1
  - @parity/product-sdk-cloud-storage@0.5.5
  - @parity/product-sdk-local-storage@0.2.4
  - @parity/product-sdk-contracts@0.7.2
  - @parity/product-sdk-keys@0.3.5
  - @parity/product-sdk-tx@0.2.9

## 0.10.0

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
- Updated dependencies [f6bdaaf]
  - @parity/product-sdk-chain-client@0.6.0
  - @parity/product-sdk-host@0.7.0
  - @parity/product-sdk-cloud-storage@0.5.4
  - @parity/product-sdk-local-storage@0.2.3
  - @parity/product-sdk-signer@0.6.1
  - @parity/product-sdk-keys@0.3.4
  - @parity/product-sdk-contracts@0.7.1
  - @parity/product-sdk-tx@0.2.8

## 0.9.0

### Minor Changes

- dc3a452: **Add `HostProviderOptions.productAccount` for product-account-only apps.**

  Apps that sign exclusively with a per-dapp derived product account (no
  wallet picker — typical for the modern PoP-mediated flow) can now pass
  `productAccount: { dotNsIdentifier, derivationIndex? }` when constructing
  `HostProvider`. When set, `connect()`:

  - Skips `getLegacyAccounts()` entirely.
  - Fetches the product account via `getProductAccount(dotNsIdentifier, derivationIndex)`.
  - Best-effort fetches the user's primary username via `getUserId()`
    and uses it as `SignerAccount.name` so apps can render
    `Hello, {name}` instead of a truncated address. Failures
    (`NotConnected`, `PermissionDenied`, codec drift) leave `name` null —
    connect still succeeds, callers fall back to whatever display rule
    they already use.
  - Returns it as a single-element `SignerAccount[]` so it flows into
    `SignerState.accounts` and becomes `selectedAccount` like any other
    account.
  - Wires `getSigner` through `getProductAccountSigner` (pinned to
    `createTransaction`).

  This obsoletes the ~25-line `class extends HostProvider` workaround every
  product app was carrying. Critically, it also fixes a v0.5.0 regression:
  when the host returns no legacy accounts, `super.connect()` rejects with
  `NoAccountsError` _before_ any product-account fetch can happen — leaving
  product-only apps stuck in `status: "disconnected"`. The new option
  bypasses that branch entirely.

  Existing consumers (apps that don't set `productAccount`) see no
  behavior change.

  Example:

  ```ts
  new HostProvider({
    productAccount: { dotNsIdentifier: "myapp.dot" },
  });
  ```

### Patch Changes

- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
- Updated dependencies [dc3a452]
  - @parity/product-sdk-host@0.6.1
  - @parity/product-sdk-signer@0.6.0
  - @parity/product-sdk-chain-client@0.5.3
  - @parity/product-sdk-cloud-storage@0.5.3
  - @parity/product-sdk-contracts@0.7.0
  - @parity/product-sdk-keys@0.3.3
  - @parity/product-sdk-tx@0.2.7
  - @parity/product-sdk-local-storage@0.2.2

## 0.8.0

### Minor Changes

- 551c1bb: **Migrate to `@novasamatech/host-api(-wrapper)` v0.8.**

  Hosts now deliver `host-api` 0.8, and products must run a matching
  `@novasamatech/host-api-wrapper` — v0.8 is wire-incompatible with v0.7.
  The catalog now pins both at `^0.8.0`, and the `host` / `statement-store`
  peer ranges require `>=0.8.0`. The Polkadot Module / SSO integration
  (`@novasamatech/host-papp` and friends, used by
  `@parity/product-sdk-terminal`) intentionally stays on 0.7.x for now, so
  `terminal` is unchanged.

  Breaking changes surfaced to consumers of these packages:

  - **`@parity/product-sdk-host` — theme payload is now a struct.** The
    `subscribeTheme` callback (`getThemeProvider`) delivers a `ThemeMode`
    `{ name, variant }` object instead of a flat `"Light" | "Dark"` string.
    Read `theme.variant` for the light/dark value and `theme.name` for the
    theme name (`{ tag: "Default" }` or `{ tag: "Custom", value }`). New
    `ThemeVariant` and `ThemeName` types are exported.
  - **`@parity/product-sdk-host` — resource-allocation tag renamed.** The
    `AllocatableResource` / `AllocatableResourceTag` value `BulletInAllowance`
    is now `BulletinAllowance`; the `RemotePermission` tag `WebRTC` is now
    `WebRtc` (pure renames from the upstream codec).
  - **`@parity/product-sdk-signer` / `@parity/product-sdk-statement-store`**
    now require the v0.8 wrapper to stay wire-compatible with a v0.8 host.

### Patch Changes

- Updated dependencies [551c1bb]
  - @parity/product-sdk-host@0.6.0
  - @parity/product-sdk-signer@0.5.0
  - @parity/product-sdk-chain-client@0.5.2
  - @parity/product-sdk-cloud-storage@0.5.2
  - @parity/product-sdk-local-storage@0.2.1
  - @parity/product-sdk-contracts@0.6.2
  - @parity/product-sdk-keys@0.3.2
  - @parity/product-sdk-tx@0.2.6

## 0.7.2

### Patch Changes

- Updated dependencies [2498950]
  - @parity/product-sdk-contracts@0.6.1

## 0.7.1

### Patch Changes

- @parity/product-sdk-chain-client@0.5.1
- @parity/product-sdk-cloud-storage@0.5.1

## 0.7.0

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

- 7610e61: **Add `getPaymentManager` for RFC-0006 host payments.**

  `@parity/product-sdk-host` now exports `getPaymentManager()` plus the `PaymentManager`, `PaymentBalance`, `PaymentStatus`, and `TopUpSource` types. The wrapper returns the shared `paymentManager` singleton from `@novasamatech/host-api-wrapper`, matching the singleton pattern already used by `getPreimageManager`, `getHostLocalStorage`, and `getAccountsProvider`.

  Closes the last `@novasamatech/host-api-wrapper` direct-import in the host-playground migration: callers can swap `createPaymentManager()` for `await getPaymentManager()`.

  Distinct from the CoinPayment / merchant-payments surface (RFC-0017). This is the user-initiated balance / top-up / payment-request flow.

- 7610e61: **Track upstream rename: `@novasamatech/product-sdk` → `@novasamatech/host-api-wrapper`.**

  Novasama renamed their host-API wrapper package from `@novasamatech/product-sdk` to `@novasamatech/host-api-wrapper`. The first release under the new name is `0.7.9-6` (a prerelease).

  ### What changed for consumers

  If you install `@parity/product-sdk-host`, `@parity/product-sdk-signer`, or `@parity/product-sdk-statement-store` and were previously satisfying their optional peer dependency on `@novasamatech/product-sdk` manually, switch your direct install to `@novasamatech/host-api-wrapper` instead:

  ```diff
  - "@novasamatech/product-sdk": "^0.7.8"
  + "@novasamatech/host-api-wrapper": "0.7.9-6"
  ```

  Same upstream package, same exports (`hostApi`, `createAccountsProvider`, `preimageManager`, `hostLocalStorage`, etc.) — only the npm package name changed.

  If you don't install the peer directly (i.e. your bundle ships without the host-side wrapper), no action needed.

  ### Catalog pin rationale

  The new package is currently only published as `0.7.9-6` (a prerelease). The catalog is pinned to exactly `0.7.9-6` rather than `^0.7.9-6` because prerelease ranges have surprising semver semantics and prereleases can be republished. The pin will move to `^0.7.9` once a stable lands; the catalog auto-bumper (`product-sdk-deps-check.yml`) will pick that up automatically.

  ### Why minor

  Renaming an optional peer dependency is a consumer-visible change: anyone who satisfies our peer manually needs to update their own install. Per `RELEASES.md`'s pre-1.0 convention, that ships as `minor`.

- 7610e61: Rename `@parity/product-sdk-bulletin` to `@parity/product-sdk-cloud-storage` and abstract the public surface away from chain-specific naming. The package is still backed by the Polkadot Bulletin Chain — the rename only affects user-facing types, methods, and configuration so callsites no longer need to know about the underlying implementation.

  ### Migration

  | Before                                 | After                               |
  | -------------------------------------- | ----------------------------------- |
  | `@parity/product-sdk-bulletin`         | `@parity/product-sdk-cloud-storage` |
  | `BulletinClient`                       | `CloudStorageClient`                |
  | `BulletinApi`                          | `CloudStorageApi`                   |
  | `BulletinChain` (preset record)        | `CloudStorageNetworks`              |
  | `BulletinNetwork` (interface)          | `CloudStorageNetwork`               |
  | `BulletinEnvironment`                  | `CloudStorageEnvironment`           |
  | `CreateBulletinClientOptions`          | `CreateCloudStorageClientOptions`   |
  | `ProductBulletinError`                 | `ProductCloudStorageError`          |
  | `Bulletin*Error` family (our errors)   | `CloudStorage*Error`                |
  | `app.bulletin`                         | `app.cloudStorage`                  |
  | `bulletin?:` config                    | `cloudStorage?:`                    |
  | `@parity/product-sdk/bulletin` subpath | `@parity/product-sdk/cloud-storage` |

  Upstream re-exports from `@parity/bulletin-sdk` (`AsyncBulletinClient`, `BulletinPreparer`, `MockBulletinClient`, `BulletinClientInterface`, `BulletinTypedApi`, `BulletinError`, `ErrorCode`) remain available on the public surface for power users.

  Chain-level identifiers (`chains.bulletin`, `@parity/product-sdk-descriptors/bulletin`, the `paseo` environment) keep their existing names — those packages are explicitly about the chain, not the storage abstraction.

### Patch Changes

- 7610e61: **Bump `@novasamatech/host-api-wrapper` and `@novasamatech/host-api` to `^0.7.9` (stable).**

  `0.7.9` is the first stable release on the `0.7.9` line. The previous catalog pinned the `0.7.9-6` prerelease exactly (no caret); this bump relaxes both entries to `^0.7.9` so the auto-bumper (`product-sdk-deps-check.yml`) can pick up future patch releases automatically.

  No source-level changes for consumers — `0.7.9` is the same API surface as the prereleases we were already shipping against.

- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
- Updated dependencies [7610e61]
  - @parity/product-sdk-host@0.5.0
  - @parity/product-sdk-chain-client@0.5.0
  - @parity/product-sdk-local-storage@0.2.0
  - @parity/product-sdk-signer@0.4.0
  - @parity/product-sdk-contracts@0.6.0
  - @parity/product-sdk-cloud-storage@0.5.0
  - @parity/product-sdk-keys@0.3.1
  - @parity/product-sdk-tx@0.2.5

## 0.6.0

### Minor Changes

- 4c13257: **Rename `@parity/product-sdk/identity`'s `deriveProductAccount` to `deriveContextAlias` (and `verifyProductAccount` to `verifyContextAlias`, `ProductAccountInfo` to `ContextAliasInfo`, field `productName` to `context`).**

  The identity-subpath helper is a blake2b256-based deterministic alias
  derivation: `aliasPublicKey = blake2b256(parentPublicKey || context)`.
  Used for scoping a parent account to a context label (an app id, a
  voting round, a channel name, etc.). The old `deriveProductAccount`
  naming collided with the _canonical_ sr25519 product-account derivation
  shared with polkadot-desktop and polkadot-app-android-v2: two distinct
  algorithms that produce different outputs from the same inputs. The
  rename makes the algorithmic difference legible at the call site.

  For the canonical sr25519 product-account derivation, see the new
  `deriveProductAccountPublicKey` in `@parity/product-sdk-keys` (this
  release wave).

  ### Breaking changes

  - `deriveProductAccount(parentAddress, productName, ss58Prefix?)` is
    now `deriveContextAlias(parentAddress, context, ss58Prefix?)`. Same
    algorithm, same output bytes, only the names changed.
  - `verifyProductAccount(productAddress, parentAddress, productName)`
    is now `verifyContextAlias(aliasAddress, parentAddress, context)`.
  - Type `ProductAccountInfo` is now `ContextAliasInfo`. Field
    `productName: string` is now `context: string`. Other fields
    (`address`, `h160Address`, `parentAddress`) unchanged.

  Runtime behavior is unchanged on the success path: addresses derived
  under the old API are bit-identical to those derived under the new API
  for the same `(parentAddress, oldProductName === newContext)` pair.

  ### Migration

  Mechanical find/replace across consumer code:

  ```ts
  // Before:
  import {
    deriveProductAccount,
    verifyProductAccount,
    type ProductAccountInfo,
  } from "@parity/product-sdk/identity";

  const acct: ProductAccountInfo = deriveProductAccount(
    parentAddress,
    "my-app"
  );
  const ok = verifyProductAccount(acct.address, parentAddress, "my-app");
  console.log(acct.productName);

  // After:
  import {
    deriveContextAlias,
    verifyContextAlias,
    type ContextAliasInfo,
  } from "@parity/product-sdk/identity";

  const alias: ContextAliasInfo = deriveContextAlias(parentAddress, "my-app");
  const ok = verifyContextAlias(alias.address, parentAddress, "my-app");
  console.log(alias.context);
  ```

  ### Why minor, not major

  Per `RELEASES.md`, pre-1.0 breaking changes go out as `minor` in this
  repo. `@parity/product-sdk` is on `0.5.0`; this rename ships at `0.6.0`.

- 4c13257: **Add `deriveProductAccountPublicKey` + `createChainCode` to `@parity/product-sdk-keys`.**

  The canonical sr25519 product-account derivation used by polkadot-desktop
  (`polkadot-desktop/src/domains/product/account/service.ts`) and
  polkadot-app-android-v2
  (`feature/products/impl/.../ProductAccountDerivationUseCase.kt`) is now
  exposed from the SDK. External clients (CLI, web hosts) can compute the
  same derived address the mobile wallet derives privately, without ever
  seeing the secret key. sr25519 soft derivation is composable on the
  parent _public_ key alone.

  ### New surface

  ```ts
  import {
    createChainCode,
    deriveProductAccountPublicKey,
  } from "@parity/product-sdk-keys";

  // Canonical product-account derivation: junctions ["product", productId, "<index>"]
  const derivedPubKey = deriveProductAccountPublicKey(
    parentPublicKey, // Uint8Array, 32-byte sr25519 public key
    "playground.dot", // productId, typically a dotNS name
    0 // derivationIndex
  );

  // Lower-level helper if you need to build custom junction paths:
  const chainCode = createChainCode("product"); // Uint8Array(32)
  ```

  `createChainCode(code)` encodes a junction the way Substrate does:

  - numeric `^\d+$` to SCALE `u64` (BigInt), zero-padded to 32 bytes
  - string to SCALE `str` (compact-length + UTF-8), zero-padded to 32 bytes
  - if the encoded form exceeds 32 bytes, `blake2b256(encoded)`

  `deriveProductAccountPublicKey(parentPubKey, productId, index)` applies
  `HDKD.publicSoft` left-to-right over the junctions `["product",
productId, String(index)]`. Returns the derived 32-byte public key.

  ### Cross-platform parity note

  `productId` MUST contain at least one non-hex character OR be of odd
  length when serialized as a string. polkadot-app-android-v2's
  `SubstrateJunctionDecoder` tries to interpret a junction as hex BEFORE
  falling through to SCALE-string encoding; polkadot-desktop and this
  implementation skip that hex branch. For productIds that happen to be
  even-length all-hex strings (e.g. `"deadbeef"`, `"c0ffee01"`), Android
  would derive a different public key. In practice, productIds are dotNS
  names like `"playground.dot"`, which contain `.` and never trip the hex
  branch.

  ### Frozen vectors

  Output is locked by four byte-for-byte test vectors in
  `packages/keys/src/product-account.test.ts`, covering the production case
  (`playground.dot`/0), the non-zero u64 numeric branch, a near-boundary
  productId, and the blake2b fallback. Parent public keys in the vectors
  are derived from deterministic 32-byte seeds via `@scure/sr25519`'s
  `secretFromSeed` + `getPublicKey` (arbitrary 32-byte buffers do not work:
  `HDKD.publicSoft` validates the Ristretto255 encoding at the entry
  point). If polkadot-desktop's derivation algorithm ever changes, run
  `packages/keys/scripts/regenerate-fixtures.ts` to re-confirm parity and
  update the vectors.

  ### Internal: `@noble/hashes` consolidated on ^2.2.0

  `@parity/product-sdk-keys` now depends on `@scure/sr25519@^2.2.0` and
  `scale-ts@^1.6.1`. The workspace is also consolidated on
  `@noble/hashes@^2.2.0` across `-address`, `-crypto`, `-terminal`, and
  `-utils` to keep a single hash-library version in the dep tree.
  Consumers see no public-API change from the noble bump (one source
  file in `-address` adjusted an import path from `@noble/hashes/sha3` to
  `@noble/hashes/sha3.js`; the extensionless form worked on noble 1.x but
  noble 2.x's package exports require the explicit `.js` suffix).

  No breaking changes here. Purely additive.

- 4c13257: **Typed permission ergonomics and an `onConnect` lifecycle hook.**

  Two additive changes that collapse the boilerplate every dapp was writing on top of `hostApi.permission` and the once-per-connect side-effect pattern. No breaking changes; existing call sites keep working.

  ### `@parity/product-sdk-host` — `RemotePermission` types + `requestPermission` wrapper

  - **`RemotePermission`, `RemotePermissionTag`, `AllocatableResourceTag`, and `AllocationOutcomeTag`** type aliases are now exported alongside the existing `AllocatableResource` / `AllocationOutcome` aliases. All derive from the `@novasamatech/host-api` SCALE codecs via `CodecType<typeof X>` so schema drift surfaces as a TypeScript error at this boundary instead of silently passing through `as never` casts.

  - **`requestPermission(permission)`** builds the `v1` envelope, calls `hostApi.permission`, and unwraps the response. Returns `Promise<boolean>` and throws on host-unavailable or wire failure — matches the shape of the existing `requestResourceAllocation` so the two helpers compose consistently.

    ```ts
    const granted = await requestPermission({
      tag: "ChainSubmit",
      value: undefined,
    });
    if (!granted) tellUserToReconnect();
    ```

  ### `@parity/product-sdk-signer` — `onConnect` lifecycle hook

  - **`SignerManagerOptions.onConnect`** is a new callback that fires exactly when the manager transitions to `"connected"` with a selected account — not on every subscribe notification while connected. Fires again after auto-reconnect, so a fresh host session re-runs the callback.

    The `ctx` argument exposes a pre-bound `requestResourceAllocation` helper (re-exported from `@parity/product-sdk-host`) plus an `AbortSignal` that fires if the user disconnects or destroys the manager mid-flight. Errors thrown from `onConnect` are logged but do not affect the connected state — the next reconnect retries.

    ```ts
    new SignerManager({
      onConnect: async (_account, { requestResourceAllocation, signal }) => {
        try {
          const outcomes = await requestResourceAllocation([
            { tag: "AutoSigning", value: undefined },
          ]);
          if (signal.aborted) return;
          if (outcomes.some((o) => o.tag !== "Allocated")) {
            logWarning("partial permissions", outcomes);
          }
        } catch (cause) {
          logWarning("resource allocation failed", cause);
        }
      },
    });
    ```

    Replaces ~50 lines of transition-gated subscription, once-per-session bookkeeping, and HMR cleanup that every product app was writing by hand.

### Patch Changes

- 4c13257: **Bump `@parity/host-api-test-sdk` catalog to `^0.8.2`.**

  Picks up [paritytech/host-api-test-sdk#19](https://github.com/paritytech/host-api-test-sdk/pull/19) (and follow-ups) which refresh `PASEO_ASSET_HUB`, `PREVIEWNET`, and `PREVIEWNET_ASSET_HUB` to their live genesis hashes and v2 RPC endpoints. Without this bump, every e2e fixture spreading `...PASEO_ASSET_HUB` was effectively connecting under a stale genesis (v1 paseo, deprecated 2026-05-20), which broke `chain-client-demo` and downstream signing demos with `Tracking stopped` / `BadProof` / `AsPgas` errors depending on the path.

  ### What changed in the test SDK

  | Constant                           | Old                                     | New                                          |
  | ---------------------------------- | --------------------------------------- | -------------------------------------------- |
  | `PASEO_ASSET_HUB.genesisHash`      | `0xd6eec261...`                         | `0x173cea9d...`                              |
  | `PASEO_ASSET_HUB.rpcUrl`           | `wss://sys.ibp.network/asset-hub-paseo` | `wss://paseo-asset-hub-next-rpc.polkadot.io` |
  | `PREVIEWNET.genesisHash`           | `0xdd51f3c2...`                         | `0x477dd87a...`                              |
  | `PREVIEWNET_ASSET_HUB.genesisHash` | `0x7765f98d...`                         | `0x860d75a8...`                              |

  ### Consumer impact

  - **No source change** in any published `@parity/product-sdk-*` package. `@parity/host-api-test-sdk` is a `devDependency` of our example demos only — consumers installing the SDK from npm don't see this bump at all.
  - **Internal contributors** writing e2e specs against `wss://sys.ibp.network/asset-hub-paseo` or any v1 paseo genesis must update to the v2 equivalents. Per-fixture changes are usually a one-line override since most spread `...PASEO_ASSET_HUB`.

  ### Verification

  `pnpm test:e2e` runs cleanly across all demos against paseo v2 with the new SDK pulled in via the catalog (no overrides). Replaces the prior local-tarball override workflow that was a stopgap while waiting for `@parity/host-api-test-sdk@0.8.x` to publish.

- Updated dependencies [4c13257]
- Updated dependencies [4c13257]
  - @parity/product-sdk-keys@0.3.0
  - @parity/product-sdk-host@0.4.0
  - @parity/product-sdk-signer@0.3.0
  - @parity/product-sdk-bulletin@0.4.2
  - @parity/product-sdk-chain-client@0.4.2
  - @parity/product-sdk-contracts@0.5.1
  - @parity/product-sdk-tx@0.2.4
  - @parity/product-sdk-storage@0.1.5

## 0.5.0

### Minor Changes

- bdeb144: **Surface the failure payload on `QueryResult.value`.**

  A failed contract query used to return `{ success: false, value: undefined, gasRequired: undefined }` — callers had no way to tell _why_ the dry-run failed. Was the contract reverting? Was the caller account unmapped? Did the call decode at all? Diagnosing it meant reaching past the SDK with manual storage probes, even though the runtime had already reported the reason on the way back.

  `QueryResult<T>` is now a discriminated union:

  ```ts
  type QueryResult<T> =
    | { success: true; value: T; gasRequired: Weight }
    | { success: false; value: unknown; gasRequired?: Weight };
  ```

  - **Success branch** — `gasRequired` is now guaranteed non-optional (was `Weight | undefined`).
  - **Failure branch** — `value` carries the dispatch-error payload `pallet-revive` returned. Typically narrows as a tagged enum (`{ type: "Module", value: ... }`, `{ type: "ContractReverted" }`, `{ type: "AccountNotMapped" }` — see the Revive pallet error variants). `gasRequired` stays populated when the runtime reported a weight; it's optional because some failure modes don't carry one.

  ### Breaking changes

  Type-level only. Runtime behavior on the success path is unchanged.

  - Reading `.value` without first narrowing on `.success` now produces a TypeScript error — the failure branch widens it to `unknown`. The old type let this compile, but `.value` was `undefined` at runtime on failure, so any read outside an `if (success)` branch was already a latent bug.
  - Constructing a `QueryResult<T>` literal in user code (mocks, tests) now requires `gasRequired` on the success branch.
  - `QueryResult` is a `type` alias, not an `interface` — declaration merging no longer works.

  ### Migration

  If your code reads `r.value` without first checking `if (r.success)`, add the narrowing. Code that was already narrowing keeps working unchanged.

  ```ts
  // Before — compiled, but `r.value` was `undefined` at runtime on failure:
  const r = await contract.query.foo();
  processResponse(r.value);

  // After:
  const r = await contract.query.foo();
  if (r.success) {
    processResponse(r.value);
  } else {
    // r.value is `unknown` — narrow on the dispatch-error shape:
    if (
      typeof r.value === "object" &&
      r.value !== null &&
      "type" in r.value &&
      r.value.type === "ContractReverted"
    ) {
      handleRevert();
    } else {
      handleOtherFailure(r.value);
    }
  }
  ```

### Patch Changes

- Updated dependencies [bdeb144]
- Updated dependencies [bdeb144]
  - @parity/product-sdk-contracts@0.5.0
  - @parity/product-sdk-host@0.3.0
  - @parity/product-sdk-bulletin@0.4.1
  - @parity/product-sdk-chain-client@0.4.1
  - @parity/product-sdk-signer@0.2.4
  - @parity/product-sdk-storage@0.1.4
  - @parity/product-sdk-keys@0.2.3
  - @parity/product-sdk-tx@0.2.3

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
- Updated dependencies [1cc3790]
  - @parity/product-sdk-contracts@0.4.0
  - @parity/product-sdk-chain-client@0.4.0
  - @parity/product-sdk-bulletin@0.4.0
  - @parity/product-sdk-host@0.2.2
  - @parity/product-sdk-signer@0.2.3
  - @parity/product-sdk-storage@0.1.3
  - @parity/product-sdk-keys@0.2.2
  - @parity/product-sdk-tx@0.2.2

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
  - @parity/product-sdk-signer@0.2.2
  - @parity/product-sdk-chain-client@0.3.0
  - @parity/product-sdk-bulletin@0.3.0
  - @parity/product-sdk-storage@0.1.2
  - @parity/product-sdk-contracts@0.2.2
  - @parity/product-sdk-keys@0.2.1
  - @parity/product-sdk-tx@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies [6fc8188]
- Updated dependencies [6fc8188]
- Updated dependencies [6fc8188]
  - @parity/product-sdk-bulletin@0.2.1
  - @parity/product-sdk-contracts@0.2.1
  - @parity/product-sdk-signer@0.2.1
  - @parity/product-sdk-chain-client@0.2.1

## 0.2.0

### Minor Changes

- 646d591: **Bulletin: wrap `@parity/bulletin-sdk` for chunked uploads + on-chain verification.**

  `BulletinClient` now wraps upstream `AsyncBulletinClient`, gaining native chunking (>2 MiB), DAG-PB manifests, and progress events. Uploads sign and submit a `TransactionStorage.store` extrinsic; reads go through the host's preimage subscription (container-only, matching PR #26's stance — no public-gateway fetches); CID-on-chain verification is exposed via a new helper.

  ### Breaking changes — `@parity/product-sdk-bulletin`

  | Before                                                              | After                                                                                                  |
  | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
  | `BulletinClient.create("paseo")`                                    | `BulletinClient.create({ environment: "paseo", signer })` — signer is now required                     |
  | `BulletinClient.from(api)`                                          | `BulletinClient.from(inner, api)` — pass a pre-built `AsyncBulletinClient`                             |
  | `bulletin.upload(data, signer?)`                                    | `await bulletin.store(data).send()`                                                                    |
  | `bulletin.batchUpload([...])`                                       | Loop `for (const item of items) await bulletin.store(item.data).send()` (upstream has no batch helper) |
  | `result.kind === "preimage" \| "transaction"` (discriminated union) | `result: StoreResult` from upstream (`{ cid?, size, blockNumber?, extrinsicIndex?, chunks? }`)         |
  | `computeCid(data)` (sync)                                           | `await calculateCid(data)` (async — uses Web Crypto)                                                   |
  | `import { computeCid }`                                             | `import { calculateCid }` (re-exported from upstream)                                                  |

  ### New surface — `@parity/product-sdk-bulletin`

  - `BulletinClient.create({ environment, signer, config? })` — environment shorthand using built-in `BulletinChain` presets and our chain-client.
  - `BulletinClient.create({ genesisHash, descriptor, signer, config? })` — explicit form for custom networks.
  - `BulletinClient.store(data) → StoreBuilder` and the rest of upstream's fluent API (`.withChunkSize`, `.withCallback`, `.withCodec`, `.withManifest`, `.withWaitFor`).
  - `BulletinClient.fetchBytes(cid, options?)` / `BulletinClient.fetchJson(cid, options?)` — read CIDs through the host's preimage subscription. DAG-PB chunked content is reassembled transparently; pass `{ noReassemble: true }` to inspect the raw manifest.
  - `BulletinClient.verifyOnChain(cid, { block, index? })` — verify a CID was recorded in `TransactionStorage.Transactions` at a specific block. Pass `blockNumber` from a `store(...).send()` receipt for an O(1) check.
  - `BulletinClient.authorizeAccount` / `authorizePreimage` / `renew` / `estimateAuthorization` — direct passthroughs to upstream builders.
  - `createLazySigner(getSigner)` — build a `PolkadotSigner` whose underlying signer is resolved per-call. Lets the bulletin client be constructed before an account is selected, picks up account changes between calls, throws clearly on use when no signer is available.
  - `BulletinChain.paseo` — preset with genesis hash and descriptor.
  - `ProductBulletinError` — base class for read-side errors raised by this package (host availability / lookup timeout / lookup interrupted / CID format / authorization). Upstream `BulletinError` (with `code`, `retryable`, `recoveryHint`) covers upload-side failures.
  - Re-exports the upstream surface (`AsyncBulletinClient`, `BulletinPreparer`, `MockBulletinClient`, `calculateCid`, `parseCid`, `cidFromBytes`, `cidToBytes`, `convertCid`, `getContentHash`, `estimateAuthorization`, `WaitFor`, `TxStatus`, `ChunkStatus`, `ErrorCode`, etc.) so consumers don't need a separate `@parity/bulletin-sdk` import.

  ### Breaking changes — `@parity/product-sdk`

  - `BulletinApi.computeCid(data)` is now `Promise<string>` (was sync `string`). Upstream's `calculateCid` is async because it uses Web Crypto.
  - `BulletinApi.upload(data)` now requires a wallet to be connected and an account selected — uploads fail with a clear "no signer available" error otherwise. `createApp` wires a lazy signer via `SignerManager.getSigner()` so the bulletin client can still be constructed at startup.
  - `BulletinConfig.environment` narrowed from the chain-client `Environment` union to `BulletinEnvironment` (`"paseo"` only) — matches what `BulletinChain` actually has presets for.
  - Top-level `computeCid` re-export removed; `calculateCid` re-exported from `@parity/product-sdk-bulletin`.

  ### Migration

  - Connect a wallet and select an account before calling `app.bulletin.upload(...)`.
  - Replace `bulletin.upload(data)` call sites with `await bulletin.store(data).send()`; read `result.cid?.toString()` for the CID string. Handle the `undefined` case (chunked uploads with manifest disabled) explicitly.
  - Replace `computeCid(data)` with `await calculateCid(data)` (note: returns a `CID` object — call `.toString()` for the base32 string).
  - For BYOD setups, build an `AsyncBulletinClient` first (`new AsyncBulletinClient(api, signer, papiClient.submit, config?, onDestroy?)`) and pass it to `BulletinClient.from(inner, api)`.
  - Catch upstream `BulletinError` for upload/store failures (it carries `code` and `retryable`); catch `ProductBulletinError` (or its subclasses `BulletinHostUnavailableError` / `BulletinLookupTimeoutError` / `BulletinLookupInterruptedError` / `BulletinCidError` / `BulletinAuthorizationError`) for read-side failures.

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
- Updated dependencies [646d591]
- Updated dependencies [646d591]
  - @parity/product-sdk-address@0.1.1
  - @parity/product-sdk-crypto@0.1.1
  - @parity/product-sdk-logger@0.1.1
  - @parity/product-sdk-storage@0.1.1
  - @parity/product-sdk-bulletin@0.2.0
  - @parity/product-sdk-chain-client@0.2.0
  - @parity/product-sdk-contracts@0.2.0
  - @parity/product-sdk-host@0.2.0
  - @parity/product-sdk-keys@0.2.0
  - @parity/product-sdk-signer@0.2.0
  - @parity/product-sdk-tx@0.2.0

## 0.1.0

### Minor Changes

- 8a264a5: Initial release of Product SDK

  A unified SDK for building products on the Polkadot ecosystem.

### Patch Changes

- Updated dependencies [8a264a5]
  - @parity/product-sdk-address@0.1.0
  - @parity/product-sdk-bulletin@0.1.0
  - @parity/product-sdk-chain-client@0.1.0
  - @parity/product-sdk-contracts@0.1.0
  - @parity/product-sdk-crypto@0.1.0
  - @parity/product-sdk-host@0.1.0
  - @parity/product-sdk-keys@0.1.0
  - @parity/product-sdk-logger@0.1.0
  - @parity/product-sdk-signer@0.1.0
  - @parity/product-sdk-local-storage@0.1.0
  - @parity/product-sdk-tx@0.1.0
