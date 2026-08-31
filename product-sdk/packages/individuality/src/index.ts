// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * @parity/product-sdk-individuality — read a person's standing on the
 * individuality chain, and act as that person on it.
 *
 * Two halves. The **read** half goes in both directions: for a DotNS username or
 * an account, what is that person's personhood state, as of one pinned finalized
 * block? And for an account, what usernames does it hold? The **write** half is
 * `withAsPerson`, which wraps a signer so a call dispatches under a person origin
 * instead of an account origin.
 *
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 * import { readPersonhoodState } from "@parity/product-sdk-individuality";
 *
 * const chain = await getChainAPI("paseo");
 * const result = await readPersonhoodState(chain, { username: "alice.dot" });
 * if (!result.ok) {
 *     console.error(result.error);
 * } else if (result.value.tag === "Resolved") {
 *     const { state, metrics } = result.value;
 *     console.log(state.tag, metrics.score, "of", metrics.personhoodThreshold);
 * }
 *
 * const byAccount = await readPersonhoodState(chain, { account: aliceAddress });
 * ```
 *
 * And the other direction, from an account:
 *
 * ```ts
 * import { getChainAPI } from "@parity/product-sdk-chain-client";
 * import { displayUsername, lookupUsername } from "@parity/product-sdk-individuality";
 *
 * const chain = await getChainAPI("paseo");
 * const usernames = await lookupUsername(chain, { account: rootAddress });
 * if (usernames.ok && usernames.value !== null) {
 *     console.log(displayUsername(usernames.value));
 * }
 * ```
 *
 * Failures arrive on the `err` channel as a `ProductIndividualityError`, per the
 * SDK-wide error model. A username nobody owns is not a failure: it is
 * `ok({ tag: "UsernameUnowned", ... })`.
 *
 * The derivation is exported separately from the read, so the pure state
 * machine can be used against a snapshot you already hold, with no chain client
 * and no host container.
 *
 * **Not an authorization oracle.** This is a client-side read in a client-side
 * library, and a backend that trusts "the SDK said `Member`" is trivially
 * spoofed. Anything that gates value must verify on chain itself.
 *
 * The write half needs no chain client and no submitter of its own. It returns a
 * `PolkadotSigner`, so it composes with `@parity/product-sdk-tx`:
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import { withAsPerson } from "@parity/product-sdk-individuality";
 *
 * const signer = withAsPerson(accounts.getProductAccountSigner(account), {
 *     tag: "AliasWithAccount",
 * });
 * await submitAndWatch(
 *     api.tx.Game.sign_up_with_alias({ identifier_key, statement_account, sig }),
 *     signer,
 * );
 * ```
 *
 * The origin works, the call does not: `sig`, the statement-account proof, is a
 * bare `blake2_256` hash and the host's `signRaw` always `<Bytes>`-wraps it.
 * `signup-types.ts` has the sign-up blockers.
 */

// The seven-state union, its wrappers, and the pinned-block coordinates.
export type {
    AbsenceGracePolicy,
    FinalizedSnapshot,
    PersonhoodInputs,
    PersonhoodMetrics,
    PersonhoodParticipant,
    PersonhoodResult,
    PersonhoodState,
} from "./types.js";

// The pure derivation, for a snapshot the caller already holds. `missesInWindow`
// comes with it, or a caller reproducing `metrics.misses` reaches for the
// projected count the grace policy uses instead.
export { derivePersonhoodState, missesInWindow } from "./derive.js";

// Raw storage values to domain shapes, for callers doing their own reads.
export { decodeAbsenceGracePolicy, toPersonhoodParticipant } from "./decode.js";
export type { RawParticipant, RawRecognition, RawStreak } from "./decode.js";

// The pinned batched read.
export { readPersonhoodState } from "./read.js";
export type { IndividualityChain, RawAccountAlias, ReadPersonhoodStateOptions } from "./read.js";

// The account to username direction, over `Resources.Consumers`. A lite name is
// always present; a full one appears once the person claimed a bare name, which
// is also exactly when they stop being eligible to claim.
export {
    canClaimFullUsername,
    decodeConsumerInfo,
    displayUsername,
    lookupUsername,
    usernameBase,
} from "./username.js";
export type {
    ConsumersChain,
    ConsumerUsernames,
    LookupUsernameOptions,
    RawConsumerInfo,
    UsernameCredibility,
} from "./username.js";

// The prize-draw half: derive a draw's event id, then read the draw at one
// pinned block. Two pallets schedule draws through the same `Airdrop` mechanism,
// so the reads are keyed by event id and know nothing about which one did.
export type {
    AirdropAssetId,
    AirdropDraw,
    AirdropEvent,
    AirdropOutcome,
    AirdropPhase,
    AirdropPrize,
    AirdropRegistrant,
    AirdropStatusTag,
} from "./airdrop-types.js";

// The derivations. Pure, so they work against an index you already hold. Prefer
// `readGameAirdropEventIds` over the pinned base: the chain exposes `Game`'s base
// as a constant, and a hardcoded copy would derive ids for draws that do not
// exist if it ever moved. `PeopleAirdrops`' base is not exposed, so that one is
// pinned here and guarded by vectors.
export {
    GAME_AIRDROP_EVENT_ID_BASE,
    MAX_GAME_AIRDROPS,
    PEOPLE_AIRDROPS_EVENT_ID_BASE,
    gameAirdropEventId,
    gameAirdropEventIds,
    peopleAirdropsEventId,
} from "./airdrop-ids.js";

// Raw `Airdrop` storage values to domain shapes, for callers doing their own
// reads. `airdropPhase` is the `Status`-to-UI-phase collapse on its own.
export {
    airdropPhase,
    statusTag,
    toAirdropEvent,
    toRawRegistrationEntry,
} from "./airdrop-decode.js";
export type {
    RawActiveEvent,
    RawAirdropEventInfo,
    RawAirdropPrize,
    RawAirdropStatus,
    RawRegistrationEntry,
} from "./airdrop-decode.js";

// The pinned draw read. `readDrawRegistration` is the prefix scan that answers
// "am I in this draw" before it runs — separate because its cost grows with the
// draw's participant count, where everything else here is a point read.
export {
    readAirdropDraw,
    readDrawRegistration,
    readGameAirdropEventIds,
} from "./airdrop-read.js";
export type {
    AirdropChain,
    DrawRegistration,
    ReadAirdropDrawOptions,
    ReadGameAirdropEventIdsOptions,
} from "./airdrop-read.js";

// The composed read behind `getDailyPrizeStatus`: a game's draws and this
// identity's outcome in each, all at one pinned block. A caller cannot assemble
// this from the two reads above without pinning two blocks.
export { readPrizeStatus } from "./prize-status.js";
export type {
    CapturedGame,
    PrizeStatus,
    PrizeStatusChain,
    ReadPrizeStatusOptions,
} from "./prize-status.js";

// The game half: what game is running, what phase it is in, and what is
// scheduled next. Between games is a success value, not an empty result.
export type {
    CurrentGame,
    CurrentGameResult,
    GamePhase,
    GamePhaseDurations,
    GameScheduledAirdrop,
    GameSchedulePreview,
    GameTimeline,
    PlayerRegistration,
} from "./game-types.js";

// Raw `Game` storage values to domain shapes, plus the phase-boundary
// arithmetic. `gameTimeline` mirrors the runtime's own `GameTimes` trait and is
// only correct for a game that does not exist yet — a created game stores its
// boundaries, and re-deriving them contradicts storage once the durations move.
export {
    gameTimeline,
    toCurrentGame,
    toGamePhaseDurations,
    toGameSchedulePreview,
} from "./game-decode.js";
export type {
    RawGameAirdrop,
    RawGameInfo,
    RawGameSchedule,
    RawGameState,
    RawPhaseDurations,
} from "./game-decode.js";

// The pinned current-game read. `players` asks about registration in the same
// read; it needs the `Players` entry, which `GamePlayersChain` adds on top.
export { readCurrentGame } from "./game-read.js";
export type { GameChain, GamePlayersChain, ReadCurrentGameOptions } from "./game-read.js";
export type { PlayerKey } from "./player-key.js";

// For callers holding their own PAPI client: build the chain shape without
// `@parity/product-sdk-chain-client`.
export { fromPapi } from "./chain.js";
export type { FinalizedBlockSource, PapiIndividualityChain } from "./chain.js";

// Signing up for the game, and entering its prize draws in the same call. The
// requirement read comes first because the event ids depend on the game index and
// the draw count together, and the entry count must match `airdrops_scheduled`
// exactly. Only the `Account` variant is buildable: the `Alias` one needs a
// ring-VRF proof at a chain-chosen context, and every context a host will sign
// under is derived from the product id. `signup-types.ts` has the detail.
export type {
    AccountVrfSignature,
    AirdropVrfVariant,
    GameSignUpRequirement,
    SignUpBlocker,
} from "./signup-types.js";
export {
    airdropVrfDomain,
    airdropVrfTranscript,
    AIRDROP_VRF_TRANSCRIPT_LABEL,
} from "./signup-vrf.js";
export type { VrfTranscript, VrfTranscriptItem } from "./signup-vrf.js";
export {
    mintAccountAirdropVrfs,
    readGameSignUpRequirement,
    signUpWithAccountTx,
} from "./signup.js";
export type {
    AirdropVrfSigner,
    MintAccountAirdropVrfsOptions,
    ReadGameSignUpRequirementOptions,
    SignUpChain,
    SignUpWithAccountOptions,
} from "./signup.js";

// Claiming a prize. `claim_airdrop` has six gates and only two are about
// personhood, so the predicate is exported separately from the read that feeds
// it. Submission stays with `@parity/product-sdk-tx`: `claimPrizeTx` returns the
// unsigned call. `confirmClaim` re-reads whether a claim landed, which is how the
// flow survives a reload — a successful claim removes the `Winners` row.
export type {
    ClaimBlocker,
    ClaimEligibility,
    ClaimEligibilityResult,
    ClaimOutcome,
    ClaimWindow,
} from "./claim-types.js";
export { deriveClaimEligibility } from "./claim-derive.js";
export type { ClaimInputs } from "./claim-derive.js";
export { claimPrizeTx, confirmClaim, readClaimEligibility } from "./claim.js";
export type {
    ClaimChain,
    ClaimTarget,
    ConfirmClaimOptions,
    ReadClaimEligibilityOptions,
} from "./claim.js";

// Proof contexts, derived offline. Everything a host signs under is
// `blake2b-256("product/" ++ productId ++ "/" ++ suffix)`, so a product can
// predict the context a host will use and compare it against what the chain
// wants. The personhood product's own contexts are enumerated because two of
// the five never reach metadata. Product ids are always full DotNS ids — the
// TLD belongs to the network, and no default is offered on purpose.
export {
    PERSONHOOD_CONTEXT_INDEX,
    PERSONHOOD_PRODUCT_NAME,
    contextSuffixBytes,
    personhoodContext,
    productContext,
} from "./contexts.js";
export type { ContextSuffix, PersonhoodContextName } from "./contexts.js";

// Where the two personhood rings live, and the one context read: a lite proof
// must be minted in `Score.score_context`, and `readScoreContext` checks that
// constant is the product derivation of `peopl.<Score.Suffix>/Index(0)` — the
// only kind of context a stock host can mint. A runtime still publishing a
// literal answers `NotProductDerived` on the ok channel, and every
// proof-building flow must treat that as a hard stop.
export { litePeopleRing, peopleRing, readScoreContext, ringCollectionId } from "./rings.js";
export type {
    ReadScoreContextOptions,
    RingLocation,
    ScoreContext,
    ScoreContextChain,
} from "./rings.js";

// The write half: wrap a signer so the call runs under a person origin. Returns
// a `PolkadotSigner`, so submission stays with `@parity/product-sdk-tx`.
export { withAsPerson } from "./as-person-signer.js";
export type { AsPersonInfo, CreateRingVRFProof, RingVRFProof } from "./as-person-signer.js";

// Its lite-personhood sibling: wrap a signer so the call runs under a lite-person
// origin via the PeopleLiteAuth extension -- the alias-bound sign-up leg and the
// unsigned, proof-authorized bind leg of the two-transaction lite sign-up.
export { withLiteAlias } from "./as-lite-alias-signer.js";
export type { LiteAliasInfo } from "./as-lite-alias-signer.js";

// The metadata-driven pieces underneath stay internal on purpose. They are
// written generically, taking an extension identifier rather than hard-coding
// `AsPerson`, so the other origin-modifying extensions on this chain can reuse
// them, and `withLiteAlias` now does. But they are implementation details of the two signers
// today, and two of their types are shapes chosen to suit it rather than to be a
// public contract. Widening a surface later never breaks anyone; narrowing one
// after it ships does. Export them when something outside this package actually
// reaches for them.

// Errors. `UsernameUnowned` is not one of them — it travels on the success
// channel as a `PersonhoodResult`. `AsPersonError` is the write half's, and
// unlike the others it is thrown rather than returned, because it happens inside
// `PolkadotSigner.signTx` where there is no `Result` channel.
export { AsPersonError, IndividualityDecodeError, ProductIndividualityError } from "./errors.js";
