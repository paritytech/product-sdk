// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Raw `Game` storage values → domain shapes, plus the phase-boundary arithmetic.
 *
 * **These timestamps are `u32` seconds where `Airdrop`'s are `u64`.** The pallets
 * genuinely disagree, so these need no narrowing check and the airdrop ones do —
 * not an oversight to normalize away. {@link gameTimeline} reimplements a runtime
 * formula and the pinned tests below are what would catch it drifting.
 */
import { toAirdropPrize } from "./airdrop-decode.js";
import type { RawAirdropPrize } from "./airdrop-decode.js";
import { IndividualityDecodeError } from "./errors.js";
import type {
    CurrentGame,
    GamePhase,
    GamePhaseDurations,
    GameSchedulePreview,
    GameScheduledAirdrop,
    GameTimeline,
} from "./game-types.js";

/** `u32` bounds, for the saturating arithmetic the runtime uses. */
const U32_MAX = 0xff_ff_ff_ff;

/** The raw `PhaseDurationValues`, from storage or from the runtime constant. */
export interface RawPhaseDurations {
    registration: number;
    shuffle: number;
    post_shuffle_margin: number;
    reporting: number;
    player_process: number;
}

/** The raw `GameState` enum. Its payloads are not read — see {@link GamePhase}. */
export interface RawGameState {
    type: string;
}

/** The raw `Game.Game` value, narrowed to the fields the domain carries. */
export interface RawGameInfo {
    index: number;
    registration_ends: number;
    shuffle_deadline: number;
    game_date: number;
    report_ends: number;
    state: RawGameState;
    max_group_size: number;
    rounds: number;
    pending_attendance: number;
    airdrops_scheduled: number;
}

/** One raw `GameAirdrop` from a schedule. */
export interface RawGameAirdrop {
    draw_offset: number;
    claim_window: number;
    prize: RawAirdropPrize;
}

/** One raw `GameSchedule` from the `Game.GameSchedules` list. */
export interface RawGameSchedule {
    game_play_time: number;
    rounds: number;
    max_group_size: number;
    airdrops: RawGameAirdrop[];
}

/**
 * The boundary each phase runs to, `null` where it ends on work. A lookup rather
 * than a `switch` so a new {@link GamePhase} fails to compile here — classifying it
 * must not be skippable.
 */
const DEADLINE_FIELD: Record<GamePhase, keyof RawGameInfo | null> = {
    Registration: "registration_ends",
    Shuffle: "shuffle_deadline",
    Reporting: "report_ends",
    // Both run until their sub-steps finish. `game_date` and `report_ends` are
    // already behind them, and the chain stores no boundary for either.
    PlayerProcess: null,
    Cancelling: null,
};

/** Validate a raw `GameState` variant name. The domain tags match it exactly. */
function gamePhase(type: string): GamePhase {
    if (type in DEADLINE_FIELD) {
        return type as GamePhase;
    }
    throw new IndividualityDecodeError("unknown game state variant");
}

/** Clamp to `u32`, matching the runtime's saturating arithmetic. */
function saturate(value: number): number {
    if (value < 0) return 0;
    return value > U32_MAX ? U32_MAX : value;
}

/** Map the raw phase durations, from either source. */
export function toGamePhaseDurations(raw: RawPhaseDurations): GamePhaseDurations {
    return {
        registration: raw.registration,
        shuffle: raw.shuffle,
        postShuffleMargin: raw.post_shuffle_margin,
        reporting: raw.reporting,
        playerProcess: raw.player_process,
    };
}

/**
 * A line-for-line mirror of the runtime's `GameTimes` trait, including
 * `saturating_sub` clamping at zero — reachable for a play time earlier than the
 * phases before it.
 *
 * ```text
 * registrationStarts = play - shuffle - postShuffleMargin - registration
 * registrationEnds   = play - shuffle - postShuffleMargin
 * shuffleDeadline    = play - postShuffleMargin
 * reportingEnds      = play + reporting
 * playerProcessEnds  = play + reporting + playerProcess
 * ```
 *
 * Only correct for a game that does not exist yet — a created game stores its own.
 */
export function gameTimeline(gamePlayTime: number, durations: GamePhaseDurations): GameTimeline {
    const beforeShuffle = saturate(gamePlayTime - durations.shuffle - durations.postShuffleMargin);
    return {
        registrationStarts: saturate(beforeShuffle - durations.registration),
        registrationEnds: beforeShuffle,
        shuffleDeadline: saturate(gamePlayTime - durations.postShuffleMargin),
        gamePlayTime,
        reportingEnds: saturate(gamePlayTime + durations.reporting),
        playerProcessEnds: saturate(gamePlayTime + durations.reporting + durations.playerProcess),
    };
}

/**
 * Map the raw running game, selecting the deadline that belongs to its phase.
 *
 * @throws IndividualityDecodeError on a `GameState` variant this package does not
 *   know.
 */
export function toCurrentGame(raw: RawGameInfo): CurrentGame {
    const phase = gamePhase(raw.state.type);
    const field = DEADLINE_FIELD[phase];

    return {
        index: raw.index,
        phase,
        // Read from the field the phase names, so a phase whose boundary has
        // already passed still reports that boundary rather than the next one.
        nextDeadline: field === null ? null : (raw[field] as number),
        registrationEnds: raw.registration_ends,
        shuffleDeadline: raw.shuffle_deadline,
        gamePlayTime: raw.game_date,
        reportingEnds: raw.report_ends,
        maxGroupSize: raw.max_group_size,
        rounds: raw.rounds,
        pendingAttendance: raw.pending_attendance,
        airdropsScheduled: raw.airdrops_scheduled,
    };
}

/** Map one scheduled draw. The prize shape is the airdrop pallet's own. */
function toScheduledAirdrop(raw: RawGameAirdrop): GameScheduledAirdrop {
    return {
        drawOffset: raw.draw_offset,
        claimWindow: raw.claim_window,
        prize: toAirdropPrize(raw.prize),
    };
}

/**
 * Map one upcoming schedule, deriving its timeline from the given durations.
 *
 * The durations must come from the same block as the schedule, or the projection
 * describes a game under rules that were never in force together.
 */
export function toGameSchedulePreview(
    raw: RawGameSchedule,
    durations: GamePhaseDurations,
): GameSchedulePreview {
    return {
        gamePlayTime: raw.game_play_time,
        rounds: raw.rounds,
        maxGroupSize: raw.max_group_size,
        airdrops: raw.airdrops.map(toScheduledAirdrop),
        timeline: gameTimeline(raw.game_play_time, durations),
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const DURATIONS: GamePhaseDurations = {
        registration: 3_600,
        shuffle: 600,
        postShuffleMargin: 300,
        reporting: 1_800,
        playerProcess: 900,
    };

    /** A round play time, so every boundary below is checkable by eye. */
    const PLAY_TIME = 1_800_000_000;

    const rawPrize = (): RawAirdropPrize => ({
        asset_id: { parents: 1, interior: { type: "Here", value: undefined } },
        asset_amount: 7_000n,
        max_winners: 20,
        winner_cap: 50_000,
    });

    const rawGame = (overrides: Partial<RawGameInfo> = {}): RawGameInfo => ({
        index: 41,
        registration_ends: PLAY_TIME - 900,
        shuffle_deadline: PLAY_TIME - 300,
        game_date: PLAY_TIME,
        report_ends: PLAY_TIME + 1_800,
        state: { type: "Registration" },
        max_group_size: 5,
        rounds: 3,
        pending_attendance: 0,
        airdrops_scheduled: 2,
        ...overrides,
    });

    describe("toGamePhaseDurations", () => {
        test("renames post_shuffle_margin and player_process", () => {
            expect(
                toGamePhaseDurations({
                    registration: 1,
                    shuffle: 2,
                    post_shuffle_margin: 3,
                    reporting: 4,
                    player_process: 5,
                }),
            ).toEqual({
                registration: 1,
                shuffle: 2,
                postShuffleMargin: 3,
                reporting: 4,
                playerProcess: 5,
            });
        });
    });

    describe("gameTimeline", () => {
        test("derives every boundary from the play time", () => {
            // Written out rather than computed from the durations, so a formula
            // change here fails instead of moving with the code.
            expect(gameTimeline(PLAY_TIME, DURATIONS)).toEqual({
                registrationStarts: PLAY_TIME - 600 - 300 - 3_600,
                registrationEnds: PLAY_TIME - 600 - 300,
                shuffleDeadline: PLAY_TIME - 300,
                gamePlayTime: PLAY_TIME,
                reportingEnds: PLAY_TIME + 1_800,
                playerProcessEnds: PLAY_TIME + 1_800 + 900,
            });
        });

        test("the boundaries stay in chronological order", () => {
            const t = gameTimeline(PLAY_TIME, DURATIONS);
            const order = [
                t.registrationStarts,
                t.registrationEnds,
                t.shuffleDeadline,
                t.gamePlayTime,
                t.reportingEnds,
                t.playerProcessEnds,
            ];
            expect([...order].sort((a, b) => a - b)).toEqual(order);
        });

        test("clamps at zero rather than going negative, like saturating_sub", () => {
            // A play time inside the pre-game phases. Reachable, and a negative
            // timestamp here would render as 1969.
            const t = gameTimeline(60, DURATIONS);
            expect(t.registrationStarts).toBe(0);
            expect(t.registrationEnds).toBe(0);
            expect(t.shuffleDeadline).toBe(0);
            expect(t.gamePlayTime).toBe(60);
        });

        test("clamps at u32 rather than overflowing, like saturating_add", () => {
            const t = gameTimeline(U32_MAX, DURATIONS);
            expect(t.reportingEnds).toBe(U32_MAX);
            expect(t.playerProcessEnds).toBe(U32_MAX);
        });

        test("zero durations collapse every boundary onto the play time", () => {
            const zero: GamePhaseDurations = {
                registration: 0,
                shuffle: 0,
                postShuffleMargin: 0,
                reporting: 0,
                playerProcess: 0,
            };
            const t = gameTimeline(PLAY_TIME, zero);
            expect(new Set(Object.values(t))).toEqual(new Set([PLAY_TIME]));
        });
    });

    describe("toCurrentGame", () => {
        test("maps every field of a representative game", () => {
            expect(toCurrentGame(rawGame())).toEqual({
                index: 41,
                phase: "Registration",
                nextDeadline: PLAY_TIME - 900,
                registrationEnds: PLAY_TIME - 900,
                shuffleDeadline: PLAY_TIME - 300,
                gamePlayTime: PLAY_TIME,
                reportingEnds: PLAY_TIME + 1_800,
                maxGroupSize: 5,
                rounds: 3,
                pendingAttendance: 0,
                airdropsScheduled: 2,
            });
        });

        test.each([
            ["Registration", "registration_ends"],
            ["Shuffle", "shuffle_deadline"],
            ["Reporting", "report_ends"],
        ] as Array<[GamePhase, keyof RawGameInfo]>)(
            "%s takes its deadline from %s",
            (phase, field) => {
                const raw = rawGame({ state: { type: phase } });
                expect(toCurrentGame(raw).nextDeadline).toBe(raw[field]);
            },
        );

        test.each(["PlayerProcess", "Cancelling"])(
            "%s has no deadline, because it ends on work",
            (phase) => {
                expect(toCurrentGame(rawGame({ state: { type: phase } })).nextDeadline).toBeNull();
            },
        );

        test("reports a deadline that has already passed, rather than the next one", () => {
            // The transition runs in an offchain worker's own time, so a phase
            // outliving its boundary is normal. Skipping ahead here would report
            // a phase the chain is not in.
            const raw = rawGame({
                state: { type: "Registration" },
                registration_ends: 1_000,
                shuffle_deadline: 2_000,
            });
            expect(toCurrentGame(raw).nextDeadline).toBe(1_000);
        });

        test("ignores the state payload entirely", () => {
            // Payloads are offchain-worker bookkeeping. A step cursor changing
            // must not change the decoded game.
            const withPayload = rawGame({
                state: { type: "Reporting", player_count: 9 } as RawGameState,
            });
            expect(toCurrentGame(withPayload)).toEqual(
                toCurrentGame(rawGame({ state: { type: "Reporting" } })),
            );
        });

        test("throws on an unknown state variant", () => {
            expect(() => toCurrentGame(rawGame({ state: { type: "Reshuffling" } }))).toThrow(
                IndividualityDecodeError,
            );
        });

        test("never interpolates chain data into a decode error message", () => {
            expect(() => toCurrentGame(rawGame({ state: { type: "Reshuffling" } }))).toThrow(
                /^unknown game state variant$/,
            );
        });

        test("covers all five chain phases", () => {
            expect(Object.keys(DEADLINE_FIELD)).toHaveLength(5);
        });
    });

    describe("toGameSchedulePreview", () => {
        test("maps a schedule and derives its timeline", () => {
            const preview = toGameSchedulePreview(
                {
                    game_play_time: PLAY_TIME,
                    rounds: 4,
                    max_group_size: 6,
                    airdrops: [{ draw_offset: 3_600, claim_window: 7_200, prize: rawPrize() }],
                },
                DURATIONS,
            );

            expect(preview.gamePlayTime).toBe(PLAY_TIME);
            expect(preview.rounds).toBe(4);
            expect(preview.maxGroupSize).toBe(6);
            expect(preview.timeline).toEqual(gameTimeline(PLAY_TIME, DURATIONS));
            expect(preview.airdrops).toEqual([
                {
                    drawOffset: 3_600,
                    claimWindow: 7_200,
                    prize: {
                        assetId: { parents: 1, interior: { type: "Here", value: undefined } },
                        assetAmount: 7_000n,
                        maxWinners: 20,
                        winnerCapPermill: 50_000,
                    },
                },
            ]);
        });

        test("a schedule with no draws yields an empty list, not a missing field", () => {
            const preview = toGameSchedulePreview(
                { game_play_time: PLAY_TIME, rounds: 1, max_group_size: 4, airdrops: [] },
                DURATIONS,
            );
            expect(preview.airdrops).toEqual([]);
        });

        test("keeps the draws in the order the chain stores them", () => {
            // The order is the airdrop index, so reordering here would mislabel
            // every draw.
            const preview = toGameSchedulePreview(
                {
                    game_play_time: PLAY_TIME,
                    rounds: 1,
                    max_group_size: 4,
                    airdrops: [
                        { draw_offset: 10, claim_window: 1, prize: rawPrize() },
                        { draw_offset: 20, claim_window: 2, prize: rawPrize() },
                    ],
                },
                DURATIONS,
            );
            expect(preview.airdrops.map((a) => a.drawOffset)).toEqual([10, 20]);
        });
    });
}
