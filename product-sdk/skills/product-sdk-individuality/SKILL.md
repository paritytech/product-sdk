---
name: product-sdk-individuality
description: >
  Use when reading a person's personhood or membership standing on the individuality chain
  from a DotNS username. Covers readPersonhoodState and its Result return, the seven-state
  PersonhoodState union, why UsernameUnowned is a success value rather than an error, using
  the pure derivation without a chain client, and the decode helpers for raw
  Score.Participants values.
---

# Product SDK Individuality

Answers two questions, in opposite directions. **For a DotNS username, what is that person's personhood state on the individuality chain, as of one pinned finalized block?** And **for an account, what usernames does it hold?**

Package: `@parity/product-sdk-individuality` (also re-exported from `@parity/product-sdk/individuality`)

> **NOT AN AUTHORIZATION ORACLE.** This is a client-side read in a client-side library. A backend that trusts "the SDK said `Member`" is trivially spoofed. Anything gating value must verify on chain itself.

> **RETURNS A `Result`**, per the SDK-wide error model. `ok` carries the answer, `err` carries a `ProductIndividualityError`. Nothing throws.

> **`UsernameUnowned` IS A SUCCESS VALUE**, not an error. The chain was asked and answered that nobody owns that username, so it arrives as `ok({ tag: "UsernameUnowned", ... })`.

> **ALL READS SHARE ONE FINALIZED BLOCK.** Two of the six underlying values move on a session cadence, so mixing blocks would silently mix eras. The block used is reported back on every result.

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

Four things the chain guarantees, all worth knowing before you render any of this:

| | |
|---|---|
| `liteUsername` | always present, always `<letters>.<digits>`, for example `bigtava.07` |
| `fullUsername` | the claimed bare name, letters only, no dot. Present exactly when the person claimed one |
| eligibility | `canClaimFullUsername(record)` is `fullUsername === null`, which is the literal precondition the claim extrinsic checks |
| `credibility` | `{ tag: "Lite" }` before a claim, `{ tag: "Person", alias, demoted }` after |

**A `demoted` person is still a `Person`, and still has their full username.** Demotion fires when the
person authorization goes stale and it rewrites only that flag, so `credibility.tag === "Person"` on
its own does **not** mean "in good standing". Check `demoted`.

`usernameBase("bigtava.07")` gives `"bigtava"`, the name a claim would suggest. It is a suggestion,
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
      accountAddress: string;         // owner of the DotNS username
      alias: string | null;           // contextual People alias, or null
      state: PersonhoodState;
    };
```

`at` is on both arms, so you can cache against it or compare two results and know which is newer. The whole union sits inside `result.value`.

The alias is read from **both** `People.AccountToAlias` and `PeopleLite.AccountToAlias`, preferring the former. A Lite person's alias lives in the second, and without it the alias-keyed participant lookup would never run for them.

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

## Common Mistakes

1. **Forgetting to check `result.ok` first** — the answer is inside `result.value`, and a `result.tag` check on the outer object is always undefined.
2. **Treating `UsernameUnowned` as an error** — it is a valid answer on the ok channel.
3. **Comparing `score` to `personhoodThreshold` to decide membership** — the chain owns `reachedPersonhood`; both numbers are reported, never compared. Someone sitting exactly on the threshold is still `Candidate`.
4. **Reading `Caution.misses` as misses already taken** — it is a *projection* of what the window would hold after one more absence.
5. **Assuming `window === 0` behaves like other windows** — it means no grace at all, so the next absence suspends regardless of the count. `Caution` there can carry a `misses` value *below* `allowedMisses`.
6. **Using this to gate value server-side** — see the first callout.
7. **Normalizing the username first** — it is UTF-8 encoded as-is. Pass the exact byte string the chain stores, `.dot` suffix included.
8. **Expecting `alias` to be the DotNS text** — it is the contextual People alias, or `null`. Never the username.
9. **Reading the six values at different blocks** if you roll your own read — the threshold and grace ratio are session-updated, so an unpinned batch can mix eras and look valid.
