// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * One game exists at a time and `Game.Game` is empty between them, hence a two-arm
 * union rather than a nullable game.
 *
 * **Stored boundaries and derived ones are not interchangeable.** A running game
 * carries the boundaries it was created with, and governance can move the durations
 * afterwards, so re-deriving would contradict storage. {@link GameTimeline} is
 * therefore only on {@link GameSchedulePreview}, where play time is all there is.
 *
 * **Paseo only.** Devnet's metadata predates this work — one optional prize per
 * schedule, no `airdrops_scheduled`, an extra `airdrop_claim_window` — so a devnet
 * client fails `GameChain`, which the umbrella's contract test asserts deliberately.
 */
import type { AirdropPrize } from "./airdrop-types.js";
import type { FinalizedSnapshot } from "./types.js";

/**
 * The phase a game is in, named as the chain's `GameState` variant. Their payloads
 * are not decoded — offchain-worker cursors and sub-step markers, not anything a
 * product renders; `pendingAttendance` is the progress signal that is.
 */
export type GamePhase =
    /** Sign-ups are open until `registrationEnds`. */
    | "Registration"
    /** Registration closed; players are being grouped, until `shuffleDeadline`. */
    | "Shuffle"
    /** The game has been played; players report each other until `reportingEnds`. */
    | "Reporting"
    /** Reporting closed; results are being settled. Ends on work, not on a clock. */
    | "PlayerProcess"
    /**
     * The game was abandoned and is cleaning up — too few players to group, or a
     * missed shuffle deadline. No prizes, and the game is not replayed.
     */
    | "Cancelling";

/**
 * The phase durations in force, from `Game.StoredPhaseDurations` when governance
 * has set one and `Game.DefaultPhaseDurations` otherwise. All in seconds.
 */
export interface GamePhaseDurations {
    registration: number;
    shuffle: number;
    /** Slack between the shuffle deadline and the play time. */
    postShuffleMargin: number;
    reporting: number;
    playerProcess: number;
}

/**
 * A game's phase boundaries, Unix **seconds**. Mirrors the runtime's `GameTimes`
 * trait (`pallets/game/src/types.rs:525`), and is only ever a projection, for a
 * game that does not exist yet.
 */
export interface GameTimeline {
    /** Earliest the game may open for sign-ups. */
    registrationStarts: number;
    registrationEnds: number;
    /** Miss this and the game is cancelled rather than played. */
    shuffleDeadline: number;
    gamePlayTime: number;
    reportingEnds: number;
    /** End of the whole game. The chain schedules nothing else before it. */
    playerProcessEnds: number;
}

/** One prize draw a schedule will set up, with its timing relative to play time. */
export interface GameScheduledAirdrop {
    /** Seconds after the play time at which winners are drawn. */
    drawOffset: number;
    /** Seconds the claim window stays open after the draw. */
    claimWindow: number;
    prize: AirdropPrize;
}

/** The game that is running now. */
export interface CurrentGame {
    /**
     * The game index, which is also the `game_index` a prize claim takes.
     *
     * Games are numbered from 1: the counter is incremented when a game is
     * created, so index 0 never names one.
     */
    index: number;
    phase: GamePhase;
    /**
     * The boundary this phase runs to, `null` for `PlayerProcess` and `Cancelling`,
     * which end on work rather than time. Taken from the boundary matching
     * {@link phase}, never inferred from the clock: transitions run in an offchain
     * worker's own time, so a boundary can be past while its phase is current.
     */
    nextDeadline: number | null;
    /** Unix seconds. Stored on the game, not re-derived. */
    registrationEnds: number;
    shuffleDeadline: number;
    gamePlayTime: number;
    reportingEnds: number;
    maxGroupSize: number;
    rounds: number;
    /**
     * Registered players whose attendance is not settled yet. Reaches zero when
     * every player has been resolved, which can end the reporting phase early.
     */
    pendingAttendance: number;
    /**
     * Draws actually scheduled, carrying airdrop indices `0..airdropsScheduled`.
     *
     * **Derive event ids from this, not the schedule's count.** Scheduling stops at
     * the first failure, so a game can end up with fewer draws than it asked for.
     */
    airdropsScheduled: number;
}

/**
 * A game not created yet. The chain keeps `Game.GameSchedules` chronological —
 * `schedule_games` rejects anything overlapping or preceding the last one, and
 * `remove_scheduled_game` binary-searches it — so the first entry is the next game.
 */
export interface GameSchedulePreview {
    /** Unix seconds. The only time the chain stores for a scheduled game. */
    gamePlayTime: number;
    rounds: number;
    maxGroupSize: number;
    /**
     * The draws this schedule asks for — an upper bound, since scheduling can fail
     * per draw. For showing a prize before the game exists, never for deriving
     * event ids.
     */
    airdrops: GameScheduledAirdrop[];
    /**
     * Boundaries derived from the durations at the same block — **a projection**.
     * Governance can move them before this game is created, shifting everything
     * here except `gamePlayTime`. Once it exists, read its stored boundaries.
     */
    timeline: GameTimeline;
}

/**
 * The outcome of a current-game read.
 *
 * Between games is not a failure and not an empty result: the chain was asked
 * and answered that no game is running, which is most of the time.
 */
export type CurrentGameResult =
    /** A game exists in `Game.Game`. */
    | {
          tag: "Running";
          at: FinalizedSnapshot;
          game: CurrentGame;
          /** Games after this one, chronologically. */
          upcoming: GameSchedulePreview[];
          /** The durations the {@link GameSchedulePreview} timelines were derived with. */
          durations: GamePhaseDurations;
      }
    /** `Game.Game` is empty. */
    | {
          tag: "BetweenGames";
          at: FinalizedSnapshot;
          /**
           * The game that just ended: the counter only moves at creation, so it
           * still points there. `null` before any game existed. This is the index a
           * prize from that game is claimed against.
           */
          lastGameIndex: number | null;
          upcoming: GameSchedulePreview[];
          durations: GamePhaseDurations;
      };
