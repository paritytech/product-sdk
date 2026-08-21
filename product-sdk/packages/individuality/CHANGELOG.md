# @parity/product-sdk-individuality

## 0.2.0

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

## 0.1.0

### Minor Changes

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
