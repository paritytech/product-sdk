// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `Game.claim_airdrop` has **five** gates and only two are about personhood, so a
 * caller checking recognition alone still gets errors it cannot explain.
 *
 * | Gate | On-chain error |
 * |---|---|
 * | recognized, or reached personhood | `Game.NotEligibleForAirdrop` |
 * | `last_attended_game == game_index` | `Game.NotEligibleForAirdrop` |
 * | the draw's status is `Claiming` | `Airdrop.NotClaiming` |
 * | now is before the draw's `end_time` | `Airdrop.ClaimingWindowClosed` |
 * | a `Winners` entry for this identity | `Airdrop.NoSuchWinner` |
 */
import type { AirdropPhase } from "./airdrop-types.js";
import type { FinalizedSnapshot } from "./types.js";

/**
 * Why a prize cannot be claimed. Several can hold at once, so
 * {@link ClaimEligibility} carries a list rather than the first one found — a UI
 * that says "not recognized" while the window has also closed sends the player
 * to fix the wrong thing.
 */
export type ClaimBlocker =
    /** No `Score.Participants` record at all. */
    | { tag: "NotAParticipant" }
    /** Neither recognized nor over the personhood threshold. */
    | { tag: "NotRecognized" }
    /** Recognition is `Suspended` — distinct from never having had it. */
    | { tag: "Suspended" }
    /**
     * The player attended a game after this one, which **overwrote**
     * `last_attended_game` and closed this claim for good. Not a timing problem:
     * playing again is what ended it.
     */
    | { tag: "AttendedALaterGame"; lastAttendedGame: number | null }
    /**
     * The draw is not taking claims. Before `Claiming` the winners are not
     * settled; after it the window has closed and the prize is being released.
     */
    | { tag: "DrawNotClaiming"; phase: AirdropPhase }
    /** Past the draw's `end_time`. The chain checks this itself, late OCW or not. */
    | { tag: "ClaimWindowClosed"; endTime: number }
    /**
     * No winning entry — which includes "already claimed", since claiming removes
     * the row. See {@link AirdropOutcome} for why storage cannot separate the two.
     */
    | { tag: "NoPrize" }
    /** The draw was read without a registrant, so winning was never checked. */
    | { tag: "OutcomeUnchecked" };

/**
 * When a claim stops being possible. Two deadlines apply and only one is a clock —
 * the other has no timestamp at all.
 */
export interface ClaimWindow {
    /** Unix seconds. The draw's `end_time`. */
    endTime: number;
    /**
     * Always `true` on the game path, and the reason a countdown alone misleads:
     * attending the next game moves `last_attended_game` and closes the claim,
     * usually well before `endTime`. The runtime contemplates relaxing `==` to
     * `>=`, which would make this `false`.
     */
    closesOnNextAttendance: boolean;
}

/** Whether a specific prize can be claimed, and what stops it if not. */
export interface ClaimEligibility {
    claimable: boolean;
    /** Empty exactly when `claimable` is true. */
    blockers: ClaimBlocker[];
    /**
     * The winning ticket, when there is one. Worth keeping: it is the only local
     * evidence that distinguishes "claimed" from "never won" once the chain has
     * removed the `Winners` row.
     */
    ticket: string | null;
    /** `null` when there is nothing claimable to bound. */
    window: ClaimWindow | null;
}

/** The result of checking a claim against the chain. */
export interface ClaimEligibilityResult extends ClaimEligibility {
    at: FinalizedSnapshot;
    gameIndex: number;
    airdropIndex: number;
    eventId: string;
}

/**
 * Whether a submitted claim reached the chain, re-read rather than watched. A
 * successful claim removes the `Winners` row, so the absence of a ticket that was
 * there before **is** the confirmation — recoverable after a reload, which a
 * subscription is not.
 */
export type ClaimOutcome =
    /** The ticket is gone: the claim landed. */
    | { tag: "Claimed"; at: FinalizedSnapshot }
    /** The ticket is still there, so the claim has not taken effect yet. */
    | { tag: "Pending"; at: FinalizedSnapshot; ticket: string }
    /**
     * The ticket is gone but the draw has also left `Claiming`, so the row could
     * have been swept by the lifecycle rather than by a claim. Indistinguishable
     * from here — the `PrizeClaimed` event log is the only way to be sure.
     */
    | { tag: "Unknown"; at: FinalizedSnapshot; phase: AirdropPhase };
