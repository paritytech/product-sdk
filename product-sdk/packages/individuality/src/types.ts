// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The public shapes of the personhood read layer.
 *
 * Two closed unions, both discriminated by `tag`:
 *
 * - {@link PersonhoodState} — what a person's standing on the individuality
 *   chain is, once a username has resolved to an account.
 * - {@link PersonhoodResult} — the outcome of the read itself, which may find
 *   the username unowned. That is a success value, not an error.
 *
 * Every resolved result also carries {@link PersonhoodMetrics}: the same numbers
 * the state was derived from, for a UI that renders progress regardless of which
 * state the person is in.
 *
 * Every result carries the {@link FinalizedSnapshot} it was read at. The
 * personhood threshold and the absence-grace ratio are session-updated values,
 * so two of the six underlying reads move on a session cadence — which is why
 * the block is pinned and reported rather than left implicit.
 */

/**
 * A person's membership standing, derived from one pinned snapshot.
 *
 * Ordered here roughly by progression, not by precedence. The derivation rules
 * are the authority on precedence — in particular a participant record always
 * beats Lite personhood, and external recognition is permanent.
 */
export type PersonhoodState =
    /** No participant record and not a Lite person: unknown to both pallets. */
    | { tag: "NotEnrolled" }
    /** Present in `PeopleLite.LitePeople` with no participant record. */
    | { tag: "Lite" }
    /**
     * Enrolled and accruing score, but not yet recognized and personhood not
     * yet reached.
     */
    | { tag: "Candidate"; score: number; personhoodThreshold: number }
    /** Personhood reached, but recognition has not been granted yet. */
    | { tag: "MembershipReady" }
    /**
     * A full member in good standing.
     *
     * @param activeWeeks - consecutive attended games, `0` when the current
     *   streak is an absence.
     */
    | { tag: "Member"; activeWeeks: number; lastAttendedGame: number | null }
    /**
     * A member whose next absence would breach the grace policy.
     *
     * `misses` is a *projection*, not a reading: it is what the window would
     * hold after one more absence. `window === 0` means there is no grace at
     * all, and lands here regardless of `misses`.
     */
    | {
          tag: "Caution";
          misses: number;
          allowedMisses: number;
          window: number;
          lastAttendedGame: number | null;
      }
    /**
     * Suspended by the chain, or recognized without personhood — an
     * inconsistent state the derivation fails safe into rather than throwing.
     */
    | { tag: "Suspended" };

/** The finalized block every read in a result was pinned to. */
export interface FinalizedSnapshot {
    blockHash: string;
    blockNumber: number;
}

/**
 * The absence-grace policy currently in force, decoded from
 * `Score.AbsenceGraceRatio`.
 *
 * `window` is a count of recent games; `allowedMisses` is how many of them may
 * be absences before the next one suspends. A `window` of `0` means no grace at
 * all.
 */
export interface AbsenceGracePolicy {
    allowedMisses: number;
    window: number;
}

/**
 * A participant's game record, as read from `Score.Participants` and decoded.
 *
 * `attendanceHistory` is a rolling byte: bit 0 is the most recent game, `1`
 * means attended and `0` means absent.
 */
export interface PersonhoodParticipant {
    score: number;
    streak: { tag: "Attended" | "Absent"; count: number };
    attendanceHistory: number;
    reachedPersonhood: boolean;
    recognition: "ExternallyRecognized" | "NotRecognized" | "Suspended" | "Recognized";
    lastAttendedGame: number | null;
}

/**
 * Everything {@link PersonhoodState} is derived from, resolved for one account at
 * one block.
 *
 * Named inputs rather than a snapshot on purpose: {@link FinalizedSnapshot} is
 * the block this was read at, and two exported types called Snapshot meaning
 * different things is a trap.
 */
export interface PersonhoodInputs {
    isLitePerson: boolean;
    participant: PersonhoodParticipant | null;
    /**
     * `Score.PersonhoodThreshold`. **This is a `u8` on chain**, but PAPI types
     * both `u8` and `u32` as `number`, so a width mistake here typechecks and
     * passes tests. Verified against the metadata blob on 2026-08-16.
     */
    personhoodThreshold: number;
    policy: AbsenceGracePolicy;
}

/**
 * The numbers behind a resolved state, carried alongside it.
 *
 * The state union answers "what is this person's standing"; these answer "by how
 * much", which a progress bar needs in every state rather than only in the two
 * whose variants happen to carry payload. All five come from the same pinned
 * snapshot as the state, so no extra read pays for them.
 *
 * **`misses` here is not `Caution.misses`.** This is what the window holds
 * *now*. `Caution.misses` is a projection — what it would hold after one more
 * absence — because that is what the grace policy is evaluated against. A UI
 * showing "you have missed 2 of the last 8" wants this one.
 *
 * `score` and `misses` are `null` when the account has no participant record:
 * there is no score to report and no attendance history to count. The threshold
 * and the policy are unkeyed storage values, so they are always present.
 */
export interface PersonhoodMetrics {
    score: number | null;
    /** `Score.PersonhoodThreshold`, the score at which personhood is reached. */
    personhoodThreshold: number;
    /** Absences inside the current window, or `null` with no record. */
    misses: number | null;
    /** `Score.AbsenceGraceRatio`: how many of `window` may be absences. */
    allowedMisses: number;
    /** `Score.AbsenceGraceRatio`: how many recent games the policy looks at. */
    window: number;
}

/**
 * The outcome of a personhood read.
 *
 * `UsernameUnowned` is a first-class success value: the chain was queried and
 * answered that nobody owns that username. It is not an error channel.
 */
export type PersonhoodResult =
    /** `Resources.UsernameOwnerOf` held no owner for the username. */
    | { tag: "UsernameUnowned"; at: FinalizedSnapshot }
    /**
     * An account was in hand — resolved from a username, or given directly —
     * and its standing was derived.
     *
     * @param accountAddress - the account the state belongs to: the username's
     *   owner, or the caller's own `account` input when that is what was passed.
     * @param alias - the contextual alias from `People.AccountToAlias`, or
     *   `null` when the account has none.
     * @param metrics - the numbers the state was derived from, in every state.
     */
    | {
          tag: "Resolved";
          at: FinalizedSnapshot;
          accountAddress: string;
          alias: string | null;
          state: PersonhoodState;
          metrics: PersonhoodMetrics;
      };
