---
name: product-sdk-individuality
description: >
  Use when reading a person's personhood or membership standing on the individuality chain
  from a DotNS username. Covers readPersonhoodState, the seven-state PersonhoodState union,
  why UsernameUnowned is a success value, using the pure derivation without a chain client,
  and the decode helpers for raw Score.Participants values.
---

# Product SDK Individuality

Answers one question: **for a DotNS username, what is that person's personhood state on the individuality chain, as of one pinned finalized block?**

Package: `@parity/product-sdk-individuality` (also re-exported from `@parity/product-sdk/individuality`)

> **NOT AN AUTHORIZATION ORACLE.** This is a client-side read in a client-side library. A backend that trusts "the SDK said `Member`" is trivially spoofed. Anything gating value must verify on chain itself.

> **`UsernameUnowned` IS A SUCCESS VALUE**, not an error. The chain was asked and answered that nobody owns that username. Only `IndividualityDecodeError` is thrown, and only when the chain returns a shape the descriptor says is impossible.

> **ALL READS SHARE ONE FINALIZED BLOCK.** Two of the six underlying values move on a session cadence, so mixing blocks would silently mix eras. The block used is reported back on every result.

## Quick Start

```ts
import { getChainAPI } from "@parity/product-sdk-chain-client";
import { readPersonhoodState } from "@parity/product-sdk-individuality";

const chain = await getChainAPI("paseo");
const result = await readPersonhoodState(chain, { username: "alice.dot" });

if (result.tag === "UsernameUnowned") {
  console.log(`nobody owns that username as of block ${result.at.blockNumber}`);
} else {
  console.log(result.accountAddress, result.state.tag);
  if (result.state.tag === "Member") {
    console.log(`member for ${result.state.activeWeeks} weeks`);
  }
}
```

This package does **not** resolve a chain. It takes an already-connected client, so the environment choice stays with you — see the `product-sdk-chain-connection` skill for `getChainAPI`.

## The Seven States

`result.state` is a closed union discriminated by `tag`.

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

`at` is on both arms, so you can cache against it or compare two results and know which is newer.

## Cancellation

```ts
const controller = new AbortController();
const result = await readPersonhoodState(chain, {
  username: "alice.dot",
  signal: controller.signal,
});
```

The signal is forwarded into every underlying pull. **No deadline is applied** — if you need one, wrap the call yourself.

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

Two traps that the compiler cannot catch, both verified against the committed metadata:

- **`Score.PersonhoodThreshold` is a `u8`.** PAPI types both `u8` and `u32` as `number`, so a width mistake typechecks *and* passes tests.
- **`Score.AbsenceGraceRatio` byte order is `(allowed_misses, window)`.** The metadata tuple is anonymous, so the order comes from the pallet's doc comment, not the type. Use `decodeAbsenceGracePolicy` rather than parsing the hex yourself.

Unknown `streak` or `recognition` variants throw `IndividualityDecodeError` rather than mapping to something plausible — the pallet is under active development, and a variant added by a runtime upgrade should fail loudly.

## Error Handling

```ts
import {
  ProductIndividualityError,     // package base
  IndividualityDecodeError,      // the chain returned an impossible shape
} from "@parity/product-sdk-individuality";
```

Both implement the cross-package `SdkError` marker, so `isSdkError(e)` from `@parity/product-sdk-errors` recognizes them. Error messages are fixed strings and never interpolate chain data.

## Common Mistakes

1. **Treating `UsernameUnowned` as an error** — it is a valid answer on the success channel.
2. **Comparing `score` to `personhoodThreshold` to decide membership** — the chain owns `reachedPersonhood`; both numbers are reported, never compared. Someone sitting exactly on the threshold is still `Candidate`.
3. **Reading `Caution.misses` as misses already taken** — it is a *projection* of what the window would hold after one more absence.
4. **Assuming `window === 0` behaves like other windows** — it means no grace at all, so the next absence suspends regardless of the count. `Caution` there can carry a `misses` value *below* `allowedMisses`.
5. **Using this to gate value server-side** — see the first callout.
6. **Normalizing the username first** — it is UTF-8 encoded as-is. Pass the exact byte string the chain stores, `.dot` suffix included.
7. **Expecting `alias` to be the DotNS text** — it is the contextual People alias, or `null`. Never the username.
8. **Reading the six values at different blocks** if you roll your own read — the threshold and grace ratio are session-updated, so an unpinned batch can mix eras and look valid.
