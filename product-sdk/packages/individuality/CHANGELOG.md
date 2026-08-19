# @parity/product-sdk-individuality

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
