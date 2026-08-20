---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**Read a prize draw: derive its event id, then read its state and winner at one pinned block.**

A prize draw is an `Airdrop` pallet event, and no storage entry lists it. Its 32-byte id is
derived from a base plus a counter, so the derivation is the entry point to every read here.
Two pallets schedule draws through the same mechanism and their layouts differ:

```ts
import {
    gameAirdropEventId,       // base(27) ++ airdrop_index(u8) ++ game_index(u32 BE)
    peopleAirdropsEventId,    // base(24) ++ draw_index(u64 BE)
    readAirdropDraw,
    readGameAirdropEventIds,
} from "@parity/product-sdk-individuality";

const chain = await getChainAPI("paseo");
const ids = await readGameAirdropEventIds(chain, { gameIndex, airdropsScheduled });
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
the base ever moved, with nothing local to notice. `PeopleAirdrops`' base is *not* exposed as a
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
*value*, so there is no reverse index — and the slot is the schnorrkel-expanded VRF output, which
not even the player who minted the VRF holds. Answering therefore means scanning every
registration under the event:

```ts
const registration = await readDrawRegistration(chain, { eventId, registrant });
// registration.value.slot         — the slot, which is also the ticket, or null
// registration.value.entriesScanned — what the scan cost
```

It is its own call rather than a field on `readPrizeStatus` because the cost grows with the
draw's participant count and nothing bounds it client-side. `entriesScanned` is reported so the
cost is visible after the fact. Call it when a UI needs "you are in tonight's draw", not on every
status poll.

**Registration state is not read here.** "Am I registered, before the draw runs" is a prefix
scan of every entry under the event: `Airdrop.Registrations` is keyed by the 32-byte entropy
slot with the registration entry as its *value*, so there is no reverse index — and the slot is
the schnorrkel-expanded VRF output, which not even the player who minted the VRF holds. The
scan costs `total_participants` reads, unbounded from the client's side, so it does not belong
inside a status call a UI polls.
