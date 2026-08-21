---
name: product-sdk-individuality
description: >
  Use when reading a person's personhood or membership standing on the individuality chain
  from a DotNS username or an account address, when reading the usernames an account holds, or
  when sending a transaction that must run under a person origin instead of an account origin.
  Covers readPersonhoodState and its two input forms, the raw metrics it returns alongside the
  state, lookupUsername, their Result returns, the seven-state PersonhoodState union, why
  UsernameUnowned and a missing consumer record are both success values rather than errors, using
  the pure derivation without a chain client, the decode helpers for raw Score.Participants and
  Resources.Consumers values, and withAsPerson for the AsPerson transaction extension including
  the RestrictOrigins requirement that otherwise fails every call.
---

# Product SDK Individuality

Two halves, and the read half goes both ways:

- **Read a person** - for a DotNS username or an account address, what is that person's personhood state on the individuality chain, as of one pinned finalized block?
- **Read an account** - for an account, what usernames does it hold, via `lookupUsername`?
- **Write** - send a call that dispatches under a *person* origin instead of an account origin, via `withAsPerson`.

Package: `@parity/product-sdk-individuality` (also re-exported from `@parity/product-sdk/individuality`)

> **NOT AN AUTHORIZATION ORACLE.** This is a client-side read in a client-side library. A backend that trusts "the SDK said `Member`" is trivially spoofed. Anything gating value must verify on chain itself.

> **RETURNS A `Result`**, per the SDK-wide error model. `ok` carries the answer, `err` carries a `ProductIndividualityError`. Nothing throws.

> **`UsernameUnowned` IS A SUCCESS VALUE**, not an error. The chain was asked and answered that nobody owns that username, so it arrives as `ok({ tag: "UsernameUnowned", ... })`.

> **THE PERSONHOOD READ SHARES ONE FINALIZED BLOCK.** Two of its six underlying values move on a session cadence, so mixing blocks would silently mix eras. `readPersonhoodState` pins one block and reports it back on every result. The account to username read is a single read that cannot mix eras, so it pins nothing by default and reports no block: see [Account to Username](#account-to-username).

## Quick Start

```ts
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { readPersonhoodState } from "@parity/product-sdk-individuality";

const chain = await getChainAPI("paseo");
const result = await readPersonhoodState(chain, { username: "alice.dot" });

if (!result.ok) {
  // Unreachable node, aborted signal, or the chain returned an impossible shape.
  console.error(result.error);
} else if (result.value.tag === "UsernameUnowned") {
  console.log(`nobody owns that username as of block ${result.value.at.blockNumber}`);
} else {
  const { accountAddress, state } = result.value;
  console.log(accountAddress, state.tag);
  if (state.tag === "Member") {
    console.log(`member for ${state.activeWeeks} weeks`);
  }
}
```

This package does **not** resolve a chain. It takes an already-connected client, so the environment choice stays with you — see the `product-sdk-chain-connection` skill for `getChainAPI`.

## Two Ways In

Pass a username **or** an account, never both. An account is the cheaper form: it skips the `Resources.UsernameOwnerOf` lookup rather than adding one, which is what a profile or results screen usually wants, because it already holds an address and not a name.

```ts
await readPersonhoodState(chain, { username: "alice.dot" });   // resolves the owner first
await readPersonhoodState(chain, { account: accountAddress }); // one round trip less
```

Two consequences of the account form. `UsernameUnowned` is unreachable, since nothing was looked up, so an account with no records is `Resolved` with `NotEnrolled`. And `accountAddress` on the result is your own input echoed back, so it proves nothing about the chain: with a username, the account came from `Resources.UsernameOwnerOf`.

Passing both, or neither, is an `err` result and costs no round trip. The option type rejects the obvious literal, but not `{ username: maybeName, account: maybeAccount }` where both are `string | undefined`, so the rule is enforced at runtime.

## Account to Username

The other direction, and the one a results or profile screen needs. `lookupUsername(chain, { account })`
reads `Resources.Consumers`, which is keyed by account and carries both names plus the credibility.
The account is what a paired session already gives you as `rootAddress`.

```ts
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { displayUsername, lookupUsername } from "@parity/product-sdk-individuality";

const chain = await getChainAPI("paseo");
const result = await lookupUsername(chain, { account: rootAddress });

if (!result.ok) {
  console.error(result.error);
} else if (result.value === null) {
  console.log("this account has no consumer record");
} else {
  console.log(displayUsername(result.value)); // the claimed name, else the lite one
}
```

> **NO RECORD IS `ok(null)`**, not an error. The chain was asked and answered.

> **THIS READ REPORTS NO BLOCK.** With no `at` it reads the finalized head at call time, so the answer
> is final, but nothing tells you which block it came from and two calls can land either side of a
> block boundary. When a username has to agree with a personhood answer, pass `at` the `at.blockHash`
> from the `readPersonhoodState` result.

Four things the chain guarantees, all worth knowing before you render any of this:

| | |
|---|---|
| `liteUsername` | always present, always `<letters>.<digits>`, for example `example.07` |
| `fullUsername` | the claimed bare name, letters only, no dot. Present exactly when the person claimed one |
| eligibility | `canClaimFullUsername(record)` is `fullUsername === null`, which is the literal precondition the claim extrinsic checks |
| `credibility` | `{ tag: "Lite" }` before a claim, `{ tag: "Person", alias, lastUpdate, demoted }` after |

**A `demoted` person is still a `Person`, and still has their full username.** Demotion rewrites only
that flag, so `credibility.tag === "Person"` on its own does **not** mean "in good standing".

**And neither does `demoted: false`.** The chain sets that flag only when somebody submits
`demote_auth_expired`, and nothing submits it automatically, so a person whose authorization expired
days ago still reads as `demoted: false` until someone bothers. Use `credibility.lastUpdate`, seconds
since the epoch, against the chain's `PersonAuthDuration` if you need to know whether the
authorization is current. This package does not read that constant, so it hands back the timestamp
rather than a verdict.

`usernameBase("example.07")` gives `"example"`, the name a claim would suggest. It is a suggestion,
not an entitlement: an account may hold a reservation for a different name, and the reservation is
what the chain honours.

`displayUsername` is the same rule the host applies when it computes
`account.getUserId().primaryUsername` from this record at session-pairing time. For the signed-in
user the two should agree; if they disagree, the session snapshot is older than the chain.

## The Seven States

`result.value.state` is a closed union discriminated by `tag`.

| `tag` | Means | Payload |
|---|---|---|
| `NotEnrolled` | No participant record and not a Lite person — unknown to both pallets | — |
| `Lite` | Present in `PeopleLite.LitePeople` with no participant record | — |
| `Candidate` | Enrolled and accruing score, personhood not yet reached | `score`, `personhoodThreshold` |
| `MembershipReady` | Personhood reached, recognition not yet granted | — |
| `Member` | Full member in good standing | `activeWeeks`, `lastAttendedGame` |
| `Caution` | A member whose **next** absence would breach the grace policy | `misses`, `allowedMisses`, `window`, `lastAttendedGame` |
| `Suspended` | Suspended by the chain, or recognized without personhood | — |

Three rules that are not obvious from the table:

- **A participant record always beats Lite.** `Lite` applies only when there is no record at all.
- **External recognition is permanent.** An externally-recognized person stays `Member` even when the personhood flag is unset, and is never cautioned.
- **`Suspended` is also the fail-safe.** "Recognized without personhood" is inconsistent state; the derivation returns `Suspended` rather than throwing, so a caller never has to render a broken state.

## The Result Shape

```ts
type PersonhoodResult =
  | { tag: "UsernameUnowned"; at: FinalizedSnapshot }
  | {
      tag: "Resolved";
      at: FinalizedSnapshot;          // { blockHash, blockNumber }
      accountAddress: string;         // the username's owner, or the account you passed
      alias: string | null;           // contextual People alias, or null
      state: PersonhoodState;
      metrics: PersonhoodMetrics;     // the numbers behind the state, in every state
    };
```

`at` is on both arms, so you can cache against it or compare two results and know which is newer. The whole union sits inside `result.value`.

The alias is read from **both** `People.AccountToAlias` and `PeopleLite.AccountToAlias`, preferring the former. A Lite person's alias lives in the second, and without it the alias-keyed participant lookup would never run for them.

## The Metrics

Every `Resolved` result carries `metrics` as well as `state`, from the same pinned block and at no extra read:

```ts
interface PersonhoodMetrics {
  score: number | null;          // null with no participant record
  personhoodThreshold: number;   // the score at which personhood is reached
  misses: number | null;         // absences in the current window, null with no record
  allowedMisses: number;         // how many of `window` may be absences
  window: number;                // how many recent games the policy looks at
}
```

Why it exists: the state variants only carry numbers where the derivation needed them, so `Candidate` has a score and `Member` does not. A progress bar wants the score in every state, and `metrics` is that, with no switch on the tag.

> **`metrics.misses` IS NOT `Caution.misses`.** The metric is what the window holds **now**. `Caution.misses` is a projection, what it would hold after **one more absence**, because that is what the grace policy is evaluated against. On a history of `0b11001111` they are 2 and 3. A screen showing "you have missed 2 of the last 8 games" wants the metric.

If you do your own reads instead, `missesInWindow(history, window)` is exported so you can produce the same number, and the attendance history defaults to all-attended on chain, so a new participant reads as zero misses rather than eight.

## Cancellation

```ts
const controller = new AbortController();
const result = await readPersonhoodState(chain, {
  username: "alice.dot",
  signal: controller.signal,
});
```

The signal is checked before the first call and then forwarded into every underlying pull, so an already cancelled read costs no round trip. A cancellation arrives on the `err` channel like any other failure. **No deadline is applied**, so wrap the call yourself if you need one.

## Using the Derivation Without a Chain

The state machine is pure and exported separately, so you can derive a state from a snapshot you already hold — no chain client, no host container. This is the entry point for callers doing their own reads.

```ts
import {
  derivePersonhoodState,
  decodeAbsenceGracePolicy,
  toPersonhoodParticipant,
} from "@parity/product-sdk-individuality";

const state = derivePersonhoodState({
  isLitePerson: litePersonValue != null,
  participant: rawParticipant == null ? null : toPersonhoodParticipant(rawParticipant),
  personhoodThreshold,                                   // Score.PersonhoodThreshold
  policy: decodeAbsenceGracePolicy(absenceGraceRatio),   // Score.AbsenceGraceRatio
});
```

## Chain Data Gotchas

Two traps the compiler cannot catch, both verified against the committed metadata:

- **`Score.PersonhoodThreshold` is a `u8`.** PAPI types both `u8` and `u32` as `number`, so a width mistake typechecks *and* passes tests. Nothing guards this one, so read it at the right width.
- **`Score.AbsenceGraceRatio` byte order is `(allowed_misses, window)`.** The metadata tuple is anonymous, so the order comes from the pallet's doc comment, not the type. Use `decodeAbsenceGracePolicy` rather than parsing the hex yourself: it enforces the runtime's own invariants (`window <= 8` and `allowedMisses < window`), so a swapped order fails loudly instead of silently disabling `Caution` for everyone.

Unknown `streak` or `recognition` variants throw `IndividualityDecodeError` rather than mapping to something plausible — the pallet is under active development, and a variant added by a runtime upgrade should fail loudly.

## Error Handling

```ts
import { isErrorOf } from "@parity/result";
import {
  ProductIndividualityError,     // package base, carries any other failure as `cause`
  IndividualityDecodeError,      // the chain returned an impossible shape
} from "@parity/product-sdk-individuality";

if (!result.ok) {
  if (isErrorOf(result.error, IndividualityDecodeError)) {
    // The chain and the committed metadata disagree.
  } else {
    // Transport, cancellation, or the pinned block aged out. `cause` has the original.
    console.error(result.error.cause);
  }
}
```

Both implement the cross-package `SdkError` marker, so `isSdkError(e)` from `@parity/product-sdk-errors` recognizes them. Error messages are fixed strings and never interpolate chain data.

## The Game and Its Prize Draws

Reading the game, its draws, and whether you won one. Every read pins a single finalized block and reports it, for the same reason the personhood read does.

```ts
import { readCurrentGame, readPrizeStatus } from "@parity/product-sdk-individuality";

const game = await readCurrentGame(chain);
if (game.ok && game.value.tag === "Running") {
  console.log(game.value.game.phase, game.value.game.nextDeadline);
}

const status = await readPrizeStatus(chain, {
  registrant: { tag: "Account", accountAddress },
});
if (status.ok && status.value.tag === "Draws") {
  for (const draw of status.value.draws) {
    if (draw.outcome.tag === "Won") console.log(draw.eventId, draw.phase);
  }
}
```

> **PASEO ONLY.** The committed devnet metadata predates this work: one optional prize per schedule instead of a draw list, no `airdrops_scheduled`, and a 28-byte event-id base against paseo's 27. A devnet client fails `GameChain` and the umbrella contract test asserts that on purpose.

> **NO GAME RUNNING IS A SUCCESS VALUE.** One game exists at a time and each is killed when it ends, so `BetweenGames` and `NoGame` are the normal state, not errors. Both carry `lastGameIndex`, which is the index a late claim is keyed by.

> **A DRAW NOT IN STORAGE IS A SUCCESS VALUE TOO.** It arrives as `phase: "Gone"`, the steady state for every past draw once the lifecycle cleans it up. It is not evidence the draw existed: an id that was never scheduled answers identically.

### Claiming a prize

```ts
import { readClaimEligibility, claimPrizeTx, confirmClaim } from "@parity/product-sdk-individuality";
import { submitAndWatch } from "@parity/product-sdk-tx";

const check = await readClaimEligibility(chain, { gameIndex, airdropIndex, registrant });
if (check.ok && check.value.claimable) {
  await submitAndWatch(claimPrizeTx(chain, { gameIndex, airdropIndex, beneficiary }), signer);
}
```

> **`claim_airdrop` HAS SIX GATES AND ONLY TWO ARE ABOUT PERSONHOOD.** Checking recognition alone still gets you `NotClaiming`, `ClaimingWindowClosed`, `AssetNotEnabled` or `NoSuchWinner` from the chain with nothing local to explain them. `ClaimEligibility.blockers` reports every cause, not the first, so a UI does not send someone to fix the wrong thing.

The nine reasons a claim can be blocked, in the shape the seven personhood states use above:

| `blockers[].tag` | Means |
|---|---|
| `NotAParticipant` | No `Score.Participants` record at all |
| `NotRecognized` | Neither recognized nor over the personhood threshold |
| `Suspended` | Recognition is suspended, which is not the same as never having had it |
| `DidNotAttendThisGame` | `last_attended_game` is not this game. Covers never attended, attended an earlier one, or played again since. Compare `lastAttendedGame` to the game index to tell which |
| `DrawNotClaiming` | The draw is not taking claims. `phase` says where it is instead |
| `ClaimWindowClosed` | Past the draw's `end_time` |
| `PrizeAssetDisabled` | The prize asset was disabled for airdrops. Nothing the player can do |
| `NoPrize` | No winning entry, which includes already claimed |
| `OutcomeUnchecked` | The draw was read without a registrant, so winning was never checked |

`AirdropPhase` is `Upcoming`, `Registering`, `Drawing`, `Claiming`, `Settling` or `Gone`, where `Gone` is the row's absence rather than a chain status. `confirmClaim` answers `Claimed`, `Pending` or `Unknown`, the last when the row is gone but the draw has also left `Claiming`, so the lifecycle may have swept it instead.

> **A REFUSED CLAIM COSTS A FEE.** `Pays::No` applies only on success, so a claim this library green-lights and the chain rejects costs the player money. That is why all six gates are pre-checked.

> **THE DEADLINE IS NOT A TIMESTAMP.** Attending the next game overwrites `last_attended_game` and closes the claim, usually well before the draw's `end_time`. `ClaimWindow` reports `closesOnNextAttendance` next to `endTime` because a countdown alone misleads.

> **THERE IS NO SUBSCRIPTION, AND NONE IS NEEDED.** A successful claim removes the `Winners` row, so `confirmClaim` re-reads it: a ticket still present means the claim has not landed. That survives a reload, a dropped socket and a closed tab, which a watch does not. Persist the ticket when you claim, it is the only local evidence separating "claimed" from "never won".

### Game and Prize Gotchas

- **`NotWon` means three things.** Not drawn yet, did not win, or won and already claimed, since claiming removes the row. `phase` separates the first from the rest; only a kept ticket or the `PrizeClaimed` event separates the last two.
- **A past game's draw count is unreadable.** `airdrops_scheduled` lives on `Game.Game`, which holds only the running game, but claims outlive their game. Capture the count while the game runs and pass it as `game: { index, airdropsScheduled }`. There is no probe fallback, because a cleaned-up draw and one that never existed answer identically.
- **The prize is a foreign asset.** `prize.assetId` is an XCM location, so formatting `assetAmount` with the chain's own `tokenDecimals` is wrong. Read `Assets.Metadata` for that id.
- **`winnerCapPermill` is parts per million**, not a count and not a percent.
- **`Status` counters are absent, not zero,** in the states that have not computed them. A `Finalizing` draw did have participants; the chain stopped reporting the figure.
- **A running game's boundaries are stored, an upcoming one's are projected.** Governance can move the phase durations, so re-deriving a running game's boundaries would contradict storage. `GameTimeline` appears only on an upcoming schedule.
- **`readDrawRegistration` is a prefix scan.** It answers "am I in tonight's draw" before the draw runs, which no point read can, but its cost grows with the participant count. Not for polling.
- **`Score.Participants` spells the alias variant `Person`** where the airdrop registration entry calls it `Alias`. The wrong spelling reads nothing and looks like a missing record.

## Acting As a Person (Write)

`withAsPerson` wraps a signer so the call dispatches under a person origin. It returns a `PolkadotSigner`, so submission stays with `@parity/product-sdk-tx` and nothing about `submitAndWatch` changes.

```ts
import { submitAndWatch } from "@parity/product-sdk-tx";
import { withAsPerson } from "@parity/product-sdk-individuality";

const signer = withAsPerson(accounts.getProductAccountSigner(account), {
  tag: "AliasWithAccount",
});

const result = await submitAndWatch(
  api.tx.Game.sign_up_with_alias({ identifier_key, statement_account, sig }),
  signer,
);
```

> **`RestrictOrigins` MUST BE `true`, AND THIS PACKAGE DOES IT FOR YOU.** PAPI defaults that extension to `false`, and `false` against a person origin is an immediate `InvalidTransaction::Call` from the origin-restriction pallet — before your call runs, with no dispatch error to read. If you build the extension by hand instead of using `withAsPerson`, this is the one nobody guesses.

> **THE PROOF MESSAGE IS NOT YOURS TO CHOOSE.** It is blake2-256 of the *call implication*: the pipeline version, the call data, and every extension after `AsPerson`, which includes the nonce, the era and the tip. `withAsPerson` computes it and hands it to your `createProof` callback. A proof over anything else fails on chain as a bad proof.

> **THIS ONE THROWS, IT DOES NOT RETURN A `Result`.** Unlike the read half, failures surface as a thrown `AsPersonError`, because they happen inside `PolkadotSigner.signTx` where there is no `Result` channel. `submitAndWatch` catches it and gives you back an `err`.

### Which variant

| `tag` | Origin | Needs a proof | Usable today |
|---|---|---|---|
| `AliasWithAccount` | `Signed` | No | **Yes.** The everyday case |
| `AliasWithProof` | `None` | Yes | **Not on paseo yet**, see below |
| `AliasWithAccountRevised` | `Signed` | Yes | **Not on paseo yet**, same reason |

`AliasWithAccount` requires the signing account to already be bound to the alias by `People.set_alias_account`, which the mobile apps do natively. That is the only prerequisite, and there is nothing to pass: the nonce comes from the slot PAPI already filled, so the extension's copy and the body's copy cannot disagree.

**The two proof variants need a runtime paseo has not deployed yet. It is not an encoding gap.** `set_alias_account` requires the proof's context to be one the runtime allows accounts to be bound in: the score, mob or resources context.

- **Individuality up to v0.11.2**, which is what paseo-people-next runs today at `specVersion 1000032`, fixes those contexts as constants. `createRingVRFProof` mints product-scoped contexts, `blake2b256("product/<productId>/<suffix>")`, and no input equals a constant, so the chain answers `InvalidTransaction::Call` however correct your bytes are.
- **Individuality v0.12.0**, tagged but not yet deployed, derives those contexts with the *same* product-scoped construction the host already uses. On paseo, `productId: "peopl.paseo"` with `suffix: { tag: "Index", value: 0 }` yields exactly the score context, `0x99f1920e...e842`. Both sides were computed and compared: byte-identical.

So there is nothing to build and nothing needed from the host. When paseo upgrades to `specVersion 1000035` or later, regenerate the descriptors and pass that context. Track it on issue #290.

The wiring is a callback either way, so nothing in this package changes:

```ts
const signer = withAsPerson(innerSigner, {
  tag: "AliasWithProof",
  // `message` is the implication hash, computed for you. Never choose it.
  createProof: (message) =>
    signerManager
      .createRingVRFProof(
        keyHandle,
        // The score context, once the chain derives it this way.
        { productId: "peopl.paseo", suffix: { tag: "Index", value: 0 } },
        ringLocation,
        message,
      )
      .then((r) => (r.ok ? r.value : Promise.reject(r.error))),
});
```

### If you are building the extension yourself

`withAsPerson` is the whole public surface for this, alongside `AsPersonInfo`, `CreateRingVRFProof`, `RingVRFProof` and `AsPersonError`. The metadata-driven pieces underneath are deliberately not exported: they are implementation details today, and widening a public surface later is easy where narrowing it is not. If you need them for another origin-modifying extension on this chain, they are written generically and take an extension identifier, so ask for them to be exported rather than writing a second copy.

Two things to know either way, because they are the traps that cost the most time here:

- **Encode from the runtime metadata, never from a hand-written type.** The deployed `AsPersonInfo` and the upstream `polkadot-sdk` one both have a variant called `AsPersonalAliasWithProof` with *different field lists* — the deployed one carries a revision index. An upstream-derived encoder emits plausible bytes with a field missing and no index mismatch to signal it.
- **PAPI wants different JavaScript for two byte fields that look alike.** A `BoundedVec<u8>` takes a `Uint8Array`; a `[u8; 32]` takes a `0x` string. Hand either the other form and it encodes *without throwing*, producing wrong bytes. A round trip through the chain's own codec catches that, but it cannot catch a wrong *length* on a fixed-size field, because PAPI validates no width on encode or decode. So the context length and the proof length are both checked explicitly, and a proof or context of the wrong size throws `AsPersonError` rather than building an extrinsic the node rejects.

## Common Mistakes

1. **Forgetting to check `result.ok` first** — the answer is inside `result.value`, and a `result.tag` check on the outer object is always undefined.
2. **Treating `UsernameUnowned` as an error** — it is a valid answer on the ok channel.
3. **Comparing `score` to `personhoodThreshold` to decide membership** — the chain owns `reachedPersonhood`; both numbers are reported, never compared. Someone sitting exactly on the threshold is still `Candidate`.
4. **Reading `Caution.misses` as misses already taken** — it is a *projection* of what the window would hold after one more absence. `metrics.misses` is the count already taken.
5. **Assuming `window === 0` behaves like other windows** — it means no grace at all, so the next absence suspends regardless of the count. `Caution` there can carry a `misses` value *below* `allowedMisses`.
6. **Using this to gate value server-side** — see the first callout.
7. **Normalizing the username first** — it is UTF-8 encoded as-is. Pass the exact byte string the chain stores, `.dot` suffix included.
8. **Expecting `alias` to be the DotNS text** — it is the contextual People alias, or `null`. Never the username.
9. **Reading the six values at different blocks** if you roll your own read — the threshold and grace ratio are session-updated, so an unpinned batch can mix eras and look valid.
10. **Hand-building `AsPerson` and forgetting `RestrictOrigins`** — every call fails `Invalid.Call` before dispatch, and nothing in the error points at the extension you missed.
11. **Choosing the proof message yourself** — it must be the implication hash, which depends on the nonce, era and tip. `withAsPerson` passes it to your callback; anything else is a bad proof.
12. **Expecting `withAsPerson` to return a `Result`** — it returns a `PolkadotSigner` and throws `AsPersonError` from `signTx`. Wrap it in `submitAndWatch` and read the `err` channel.
13. **Returning the host's `Result` straight out of `createProof`** — the callback must resolve to the proof object itself, so unwrap it first. Resolving with a `Result`, with `undefined`, or with a partial object throws `AsPersonError` and nothing is signed.
14. **Reaching for `AliasWithProof` to bind an alias before paseo upgrades** — the chain fixes the allowed contexts as constants until `specVersion 1000035`, so it answers `Invalid.Call` however correct the bytes are.
15. **Assuming `AliasWithAccount` works for a stale ring revision** — the chain answers `BadSigner`, and `AliasWithAccountRevised` is the variant that fixes it. It cannot be detected client-side without reading the ring root.
