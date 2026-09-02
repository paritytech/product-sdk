// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Game sign-up, and the prize-draw entry it carries.
 *
 * Sign-up and draw entry are one extrinsic: both sign-up calls take
 * `airdrops: Option<AirdropVrfs>`, one entry per scheduled draw. `None` enters no
 * draw.
 *
 * **The variant is not the caller's choice.** The chain picks it from `Score`
 * recognition and rejects the other with `InvalidAirdropVrfVariantForRecognition`.
 * `is_recognized()` is true only for `Recognized` and `ExternallyRecognized`, so
 * `Suspended` takes `Account`.
 *
 * **`Alias` cannot be built.** It needs a ring-VRF proof at
 * `blake2_256("pop:polkadot.network/airdrop" ++ event_id)`, and hosts only sign at
 * `blake2b_256("product/" ++ productId ++ "/" ++ suffix)`, which they compute
 * themselves. Fixing that is a chain or host change, not more code here. A
 * recognized player can still sign up with an account, passing no draws.
 */
import type { GamePhase } from "./game-types.js";
import type { FinalizedSnapshot } from "./types.js";

/** Which variant the chain demands of this player. Read it, never choose it. */
export type AirdropVrfVariant =
    /** Not recognized: sr25519 VRFs from the signing account's own key. */
    | "Account"
    /** Recognized: ring-VRF membership proofs. Unbuildable, see the module doc. */
    | "Alias";

/** One `AirdropVrfs::Account` entry, shaped as the host's `signVrf` returns it. */
export interface AccountVrfSignature {
    /** 32 bytes. */
    preOutput: Uint8Array;
    /** 64 bytes, the DLEQ proof. */
    proof: Uint8Array;
}

/**
 * Why a sign-up, or the draw entry inside it, cannot go ahead. A list rather than
 * the first hit: a player told "registration has closed" who is also already
 * registered fixes the wrong thing.
 *
 * Several of these stop only the draws. {@link GameSignUpRequirement} is what
 * separates the two, not this type.
 *
 * A tag must name a condition that is true on its own, or it sends the player to
 * fix the wrong thing.
 */
export type SignUpBlocker =
    /** `Game.Game` is empty → `Game.NoGame`. */
    | { tag: "NoGameRunning" }
    /** Left the registration phase → `Game.NoRegistration`. */
    | { tag: "NotInRegistration"; phase: GamePhase }
    /**
     * Past `registrationEnds` but still in the phase → `Game.NoRegistration`. The
     * chain checks the clock as well as the state, and the offchain worker that
     * moves the phase runs in its own time, so this is reachable.
     */
    | { tag: "RegistrationEnded"; registrationEnds: number }
    /** `Game.Players[who].registered` → `Game.AlreadyRegistered`. */
    | { tag: "AlreadyRegistered" }
    /** Draws only. Recognized, so the chain wants `Alias` proofs no host can mint. */
    | { tag: "AliasVrfsUnavailable" }
    /**
     * Draws only. The account arm needs an account origin, the alias arm needs
     * recognition, so an unrecognized person satisfies neither. They can sign up.
     */
    | { tag: "AccountVrfsNeedAnAccount" }
    /** Draws only. No draws scheduled, so anything but `None` fails the count check. */
    | { tag: "NoDrawsScheduled" }
    /**
     * Draws only, and only when the caller supplied `keyType`. The pallet
     * reinterprets the account id **as** an sr25519 public key, so another scheme
     * produces VRFs that cannot verify. Unreadable from chain state.
     */
    | { tag: "NotSr25519"; keyType: string };

/**
 * What the chain will accept from this player, at one pinned block. Index and draw
 * count must come from the same block: an id built from one game's index and
 * another's count addresses a draw that does not exist.
 */
export interface GameSignUpRequirement {
    at: FinalizedSnapshot;
    /** `null` between games. Not the `lastGameIndex` a late claim uses. */
    gameIndex: number | null;
    phase: GamePhase | null;
    /** Unix seconds. `null` between games. */
    registrationEnds: number | null;
    /**
     * Whether the **chain** would accept a sign-up, with or without draw entry.
     * Not whether this package can build one: an `Alias` registrant needs
     * `sign_up_with_alias`, which cannot be assembled, and still reads `true`.
     */
    canSignUp: boolean;
    /** Never true when {@link canSignUp} is false: the draws ride on the sign-up. */
    canEnterDraws: boolean;
    /** `null` between games, where recognition is known but there is nothing to enter. */
    variant: AirdropVrfVariant | null;
    /** `Game.airdrops_scheduled`. The `airdrops` list must have exactly this many entries. */
    airdropsScheduled: number;
    /** Ids for airdrop indices `0` to `airdropsScheduled - 1`, in supply order. */
    eventIds: string[];
    /** Empty exactly when both {@link canSignUp} and {@link canEnterDraws} hold. */
    blockers: SignUpBlocker[];
}

/**
 * Why the free lite sign-up (`Game.sign_up_with_account_lite_invite`) cannot go
 * ahead: every account-path blocker, plus the lite-only gates.
 *
 * A parallel union rather than new arms on {@link SignUpBlocker}, on purpose:
 * widening that union would break every existing exhaustive consumer of the
 * account read the moment this package is upgraded, for a path they never
 * call. `readGameSignUpRequirement` keeps returning the narrow union;
 * `readLiteSignUpRequirement` returns this one, and a consumer of both narrows
 * once.
 *
 * Unlike the account read's draw-only arms, every lite arm blocks the sign-up
 * itself. `AnotherAccountInvited` and `AccountIsALitePerson` are permanent for
 * the account they name; `ContextNotProductDerived` is about the environment,
 * not the account.
 */
export type LiteSignUpBlocker =
    | SignUpBlocker
    /**
     * No `PeopleLite.AccountToAlias[account]`: the proof-authorized bind leg
     * (`PeopleLite.set_alias_account` under `withLiteAlias(AliasWithProof)`)
     * has not run, so the signed leg would fail with `NoAliasBinding`.
     */
    | { tag: "AliasNotBound" }
    /**
     * The binding exists, but outside `Score.score_context`, the only context
     * the game's origin check admits. Recoverable only via
     * `PeopleLite.unset_alias_account`, which needs a proof in the old context.
     */
    | { tag: "AliasBoundElsewhere" }
    /**
     * `Game.LiteInvites[alias]` pins **forever** the one account this lite
     * person may invite, and it is not this one → `Game.AnotherAccountInvited`.
     * Carries the pinned account so a UI can name the seat that is taken.
     */
    | { tag: "AnotherAccountInvited"; invited: string }
    /**
     * `PeopleLite.LitePeople[account]` exists → `PeopleLite.AlreadyRegistered`
     * on a bind. Not the chain's `AccountInUse`, which is a binding already on
     * the account and is `AliasBoundElsewhere` here.
     */
    | { tag: "AccountIsALitePerson" }
    /**
     * Only when the caller supplied `liteMemberKey`. The key is not an
     * `Included` member of the lite people ring
     * (`Members.Members(litePeopleCollection, key)`), so no proof minted with
     * it verifies — the check `createAccountProof` runs host-side.
     */
    | { tag: "NotLiteMember" }
    /**
     * `Score.score_context` is not the product derivation of
     * `peopl.<Score.Suffix>/Index(0)` (`readScoreContext` answered
     * `NotProductDerived`), so no stock host can mint the bind leg's proof.
     * An environment fact, not an account fact.
     */
    | { tag: "ContextNotProductDerived" }
    /**
     * A `Game.Players` entry exists → `Game.UseInviteButAlreadyPlaying`. The
     * entry survives a finished game, so the lite call is right only on a
     * first sign-up and after an archive; otherwise use `signUpWithAccountTx`.
     */
    | { tag: "AlreadyPlaying" }
    /**
     * The binding predates the ring's current revision → `Custom(172)` in
     * `validate`. Re-point it with
     * `withLiteAlias({ tag: "AliasWithAccountRevised", createProof })`.
     */
    | { tag: "StaleAlias" };

/**
 * {@link GameSignUpRequirement} with the wider blocker union: what the chain
 * will accept from this account as a **lite** sign-up, at one pinned block.
 * `canSignUp` and `canEnterDraws` answer for
 * `Game.sign_up_with_account_lite_invite` — the account read's answers AND'ed
 * with "no lite blocker", since every lite arm stops the whole extrinsic.
 */
export interface LiteSignUpRequirement extends Omit<GameSignUpRequirement, "blockers"> {
    /** Empty exactly when both `canSignUp` and `canEnterDraws` hold. */
    blockers: LiteSignUpBlocker[];
}
