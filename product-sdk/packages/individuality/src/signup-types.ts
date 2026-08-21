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
