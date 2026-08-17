---
"@parity/product-sdk-individuality": minor
"@parity/product-sdk": minor
---

**New package `@parity/product-sdk-individuality`: read a person's personhood state from the individuality chain (#287).**

`readPersonhoodState(chain, { username })` answers one question — for a DotNS username, what
is that person's standing on the individuality chain? — and answers it from **one pinned
finalized block**. Two of the six underlying values (`Score.PersonhoodThreshold` and
`Score.AbsenceGraceRatio`) are session-updated with schedules behind them, so an unpinned
batch can mix eras and still look valid. The block used is reported back on every result.

The answer is a closed union of seven states, discriminated by `tag`:

| `tag` | Payload |
|---|---|
| `NotEnrolled` | — |
| `Lite` | — |
| `Candidate` | `score`, `personhoodThreshold` |
| `MembershipReady` | — |
| `Member` | `activeWeeks`, `lastAttendedGame` |
| `Caution` | `misses`, `allowedMisses`, `window`, `lastAttendedGame` |
| `Suspended` | — |

wrapped by `UsernameUnowned | Resolved`, both carrying `{ blockHash, blockNumber }`.

**`UsernameUnowned` is a success value, not an error.** The chain was asked and answered
that nobody owns that username. The only thrown error is `IndividualityDecodeError`, for
when the chain returns a shape the descriptor says is impossible — an unknown `streak` or
`recognition` variant, or a malformed grace ratio. Its messages are fixed strings and never
interpolate chain data.

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

The parameter is typed structurally — anything exposing the six storage entries satisfies it,
including a test double — matching how `getBalance` and `resolvePeopleUsernameOwner` already
type their chain arguments. That also means no dependency on
`@parity/product-sdk-chain-client`: this package depends only on
`@parity/product-sdk-errors` and `polkadot-api`.

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
