// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The pinned current-game read: nothing in, one {@link CurrentGameResult} out.
 *
 * **Every read shares one finalized block.** A schedule's timeline is only
 * meaningful against the durations in force with it, so reading them a block apart
 * can describe a game under rules that never held together.
 *
 * One value escapes that: `Game.DefaultPhaseDurations` is a constant, and PAPI
 * serves constants from the client's runtime, not from a block. It is read only when
 * `StoredPhaseDurations` is empty, and can only disagree across an upgrade mid-read.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import {
    toCurrentGame,
    toGamePhaseDurations,
    toGameSchedulePreview,
    type RawGameInfo,
    type RawGameSchedule,
    type RawPhaseDurations,
} from "./game-decode.js";
import type { CurrentGameResult, GamePhaseDurations } from "./game-types.js";
import { ProductIndividualityError } from "./errors.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import type { FinalizedSnapshot } from "./types.js";

/**
 * Structural, so a test double satisfies it. Separate from `AirdropChain` because a
 * caller reading the game needs neither it nor the personhood entries;
 * `PrizeStatusChain` is the intersection.
 *
 * Matched by hand against the paseo descriptors on 2026-08-20:
 *
 * ```
 * Game.GameIndex:             StorageDescriptor<[], number, false, never>
 * Game.Game:                  StorageDescriptor<[], GameInfo, true, never>
 * Game.GameSchedules:         StorageDescriptor<[], Array<GameSchedule>, false, never>
 * Game.StoredPhaseDurations:  StorageDescriptor<[], PhaseDurationValues, true, never>
 * Game.DefaultPhaseDurations: PlainDescriptor<PhaseDurationValues>
 * ```
 */
export interface GameChain extends PinnedChain {
    individuality: {
        constants: {
            Game: {
                /** The fallback durations, used when storage holds no override. */
                DefaultPhaseDurations(): Promise<RawPhaseDurations>;
            };
        };
        query: {
            Game: {
                /** `ValueQuery`: always answers, `0` before any game exists. */
                GameIndex: {
                    getValue(options: ReadAt): Promise<number>;
                };
                /** Absent between games, which is most of the time. */
                Game: {
                    getValue(options: ReadAt): Promise<RawGameInfo | undefined>;
                };
                /** `ValueQuery`: an empty list rather than absence. */
                GameSchedules: {
                    getValue(options: ReadAt): Promise<RawGameSchedule[]>;
                };
                /** The governance override, absent unless one has been set. */
                StoredPhaseDurations: {
                    getValue(options: ReadAt): Promise<RawPhaseDurations | undefined>;
                };
            };
        };
    };
}

/** Options for {@link readCurrentGame}. */
export interface ReadCurrentGameOptions {
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the whole
     * batch. No deadline is applied here — that belongs to the caller.
     */
    signal?: AbortSignal;
}

/**
 * **No game running is not a failure**, it is `BetweenGames` — the chain's normal
 * state, since one game exists at a time and each is killed when it ends.
 */
export async function readCurrentGame(
    chain: GameChain,
    options: ReadCurrentGameOptions = {},
): Promise<Result<CurrentGameResult, ProductIndividualityError>> {
    try {
        return ok(await runGameRead(chain, options));
    } catch (cause) {
        // normalizeError passes an existing package error through unchanged.
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/**
 * The read itself. Throws; {@link readCurrentGame} owns the `Result` boundary.
 *
 * Exported so `prize-status.ts` can run it against a block it already pinned.
 */
export async function runGameRead(
    chain: GameChain,
    options: ReadCurrentGameOptions,
    pinned?: FinalizedSnapshot,
): Promise<CurrentGameResult> {
    const { signal } = options;
    const query = chain.individuality.query.Game;

    const snapshot = await pinBlock(chain, signal, pinned);
    const at: ReadAt = readAt(snapshot, signal);

    const [gameIndex, rawGame, rawSchedules, storedDurations] = await Promise.all([
        query.GameIndex.getValue(at),
        query.Game.getValue(at),
        query.GameSchedules.getValue(at),
        query.StoredPhaseDurations.getValue(at),
    ]);

    // The constant is only needed when governance has set no override, so it is
    // not fetched otherwise — which also keeps the un-pinned read out of the
    // common path entirely.
    const durations: GamePhaseDurations = toGamePhaseDurations(
        storedDurations ?? (await chain.individuality.constants.Game.DefaultPhaseDurations()),
    );

    // Already chronological: the chain rejects a schedule that overlaps or
    // precedes the last one, so no sort is needed and imposing one would hide a
    // chain-side ordering bug rather than surface it.
    const upcoming = rawSchedules.map((schedule) => toGameSchedulePreview(schedule, durations));

    if (rawGame === undefined) {
        return {
            tag: "BetweenGames",
            at: snapshot,
            // The counter only moves when a game is created, so it still names
            // the game that just ended. Games are numbered from 1, so 0 means
            // none has ever been created.
            lastGameIndex: gameIndex === 0 ? null : gameIndex,
            upcoming,
            durations,
        };
    }

    return {
        tag: "Running",
        at: snapshot,
        // Taken from the game itself, not from `GameIndex`. The two agree while a
        // game runs, and the game's own copy is the one a prize claim is keyed
        // by.
        game: toCurrentGame(rawGame),
        upcoming,
        durations,
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapOk, unwrapErr, isErrorOf } = await import("@parity/result");
    const { IndividualityDecodeError } = await import("./errors.js");
    const { gameTimeline } = await import("./game-decode.js");

    const BLOCK = { hash: `0x${"44".repeat(32)}`, number: 12_345 };
    const PLAY_TIME = 1_800_000_000;

    const STORED: RawPhaseDurations = {
        registration: 3_600,
        shuffle: 600,
        post_shuffle_margin: 300,
        reporting: 1_800,
        player_process: 900,
    };
    /** Deliberately different from STORED, so which one was used is observable. */
    const DEFAULT: RawPhaseDurations = {
        registration: 7_200,
        shuffle: 1_200,
        post_shuffle_margin: 600,
        reporting: 3_600,
        player_process: 1_800,
    };

    const rawGame = (overrides: Partial<RawGameInfo> = {}): RawGameInfo => ({
        index: 41,
        registration_ends: PLAY_TIME - 900,
        shuffle_deadline: PLAY_TIME - 300,
        game_date: PLAY_TIME,
        report_ends: PLAY_TIME + 1_800,
        state: { type: "Reporting" },
        max_group_size: 5,
        rounds: 3,
        pending_attendance: 2,
        airdrops_scheduled: 2,
        ...overrides,
    });

    const rawSchedule = (playTime: number): RawGameSchedule => ({
        game_play_time: playTime,
        rounds: 3,
        max_group_size: 5,
        airdrops: [],
    });

    interface FakeState {
        gameIndex?: number;
        game?: RawGameInfo;
        schedules?: RawGameSchedule[];
        stored?: RawPhaseDurations;
        failOn?:
            | "GameIndex"
            | "Game"
            | "GameSchedules"
            | "StoredPhaseDurations"
            | "constant"
            | "block";
    }

    /**
     * Records which entries were read and at which block — a read that silently
     * used the best block instead of the pinned one satisfies every value
     * assertion.
     */
    function fakeChain(state: FakeState) {
        const calls: Array<{ entry: string; at: string | undefined }> = [];
        const boom = (entry: FakeState["failOn"]) => {
            if (state.failOn === entry) throw new Error(`${entry} unreachable`);
        };
        const record = (entry: string, options: ReadAt) => {
            options.signal?.throwIfAborted();
            calls.push({ entry, at: options.at });
        };

        const chain: GameChain = {
            individuality: {
                constants: {
                    Game: {
                        DefaultPhaseDurations: async () => {
                            boom("constant");
                            calls.push({ entry: "DefaultPhaseDurations", at: undefined });
                            return DEFAULT;
                        },
                    },
                },
                query: {
                    Game: {
                        GameIndex: {
                            getValue: async (options) => {
                                boom("GameIndex");
                                record("GameIndex", options);
                                return state.gameIndex ?? 41;
                            },
                        },
                        Game: {
                            getValue: async (options) => {
                                boom("Game");
                                record("Game", options);
                                return state.game;
                            },
                        },
                        GameSchedules: {
                            getValue: async (options) => {
                                boom("GameSchedules");
                                record("GameSchedules", options);
                                return state.schedules ?? [];
                            },
                        },
                        StoredPhaseDurations: {
                            getValue: async (options) => {
                                boom("StoredPhaseDurations");
                                record("StoredPhaseDurations", options);
                                return state.stored;
                            },
                        },
                    },
                },
            },
            raw: {
                individuality: {
                    getFinalizedBlock: async () => {
                        boom("block");
                        return BLOCK;
                    },
                },
            },
        };
        return { chain, calls };
    }

    describe("readCurrentGame, with a game running", () => {
        test("returns the running game with its phase and deadline", async () => {
            const { chain } = fakeChain({ game: rawGame(), stored: STORED });
            const result = unwrapOk(await readCurrentGame(chain));

            expect(result.tag).toBe("Running");
            if (result.tag !== "Running") return;
            expect(result.game.index).toBe(41);
            expect(result.game.phase).toBe("Reporting");
            expect(result.game.nextDeadline).toBe(PLAY_TIME + 1_800);
            expect(result.game.airdropsScheduled).toBe(2);
        });

        test("reports the pinned block, and reads every entry at it", async () => {
            const { chain, calls } = fakeChain({ game: rawGame(), stored: STORED });
            const result = unwrapOk(await readCurrentGame(chain));

            expect(result.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
            expect(calls).toHaveLength(4);
            expect(new Set(calls.map((call) => call.at))).toEqual(new Set([BLOCK.hash]));
        });

        test("takes the index from the game, not from the counter", async () => {
            // They agree on chain while a game runs. This pins which one is read,
            // because the game's own copy is what a prize claim is keyed by.
            const { chain } = fakeChain({
                game: rawGame({ index: 41 }),
                gameIndex: 999,
                stored: STORED,
            });
            const result = unwrapOk(await readCurrentGame(chain));
            if (result.tag !== "Running") throw new Error("expected Running");
            expect(result.game.index).toBe(41);
        });
    });

    describe("readCurrentGame, between games", () => {
        test("no game is a success value, not an error", async () => {
            const { chain } = fakeChain({ gameIndex: 41, stored: STORED });
            const result = unwrapOk(await readCurrentGame(chain));

            expect(result.tag).toBe("BetweenGames");
            if (result.tag !== "BetweenGames") return;
            expect(result.lastGameIndex).toBe(41);
        });

        test("index 0 means no game has ever been created", async () => {
            // Games are numbered from 1, so 0 is not a game that just ended.
            const { chain } = fakeChain({ gameIndex: 0, stored: STORED });
            const result = unwrapOk(await readCurrentGame(chain));
            if (result.tag !== "BetweenGames") throw new Error("expected BetweenGames");
            expect(result.lastGameIndex).toBeNull();
        });

        test("still answers when the next game is scheduled", async () => {
            const { chain } = fakeChain({
                gameIndex: 41,
                stored: STORED,
                schedules: [rawSchedule(PLAY_TIME)],
            });
            const result = unwrapOk(await readCurrentGame(chain));
            if (result.tag !== "BetweenGames") throw new Error("expected BetweenGames");

            expect(result.upcoming).toHaveLength(1);
            expect(result.upcoming[0]?.timeline.registrationStarts).toBe(
                PLAY_TIME - 600 - 300 - 3_600,
            );
        });
    });

    describe("the upcoming schedule", () => {
        test("keeps the chain's chronological order rather than re-sorting", async () => {
            // The chain enforces the order at `schedule_games`. Sorting here would
            // hide a chain-side ordering bug instead of surfacing it.
            const { chain } = fakeChain({
                game: rawGame(),
                stored: STORED,
                schedules: [rawSchedule(PLAY_TIME), rawSchedule(PLAY_TIME + 86_400)],
            });
            const result = unwrapOk(await readCurrentGame(chain));

            expect(result.upcoming.map((s) => s.gamePlayTime)).toEqual([
                PLAY_TIME,
                PLAY_TIME + 86_400,
            ]);
        });

        test("an empty schedule list is empty, not absent", async () => {
            const { chain } = fakeChain({ game: rawGame(), stored: STORED });
            expect(unwrapOk(await readCurrentGame(chain)).upcoming).toEqual([]);
        });

        test("every timeline is derived with the durations the result reports", async () => {
            const { chain } = fakeChain({
                game: rawGame(),
                stored: STORED,
                schedules: [rawSchedule(PLAY_TIME)],
            });
            const result = unwrapOk(await readCurrentGame(chain));

            expect(result.upcoming[0]?.timeline).toEqual(gameTimeline(PLAY_TIME, result.durations));
        });
    });

    describe("the phase durations", () => {
        test("prefers the stored override, and never reads the constant then", async () => {
            const { chain, calls } = fakeChain({
                game: rawGame(),
                stored: STORED,
                schedules: [rawSchedule(PLAY_TIME)],
            });
            const result = unwrapOk(await readCurrentGame(chain));

            expect(result.durations.registration).toBe(3_600);
            // The constant is the one value not pinned to the block, so staying
            // off it whenever storage answers is deliberate, not incidental.
            expect(calls.some((call) => call.entry === "DefaultPhaseDurations")).toBe(false);
        });

        test("falls back to the runtime constant when no override is set", async () => {
            const { chain, calls } = fakeChain({
                game: rawGame(),
                schedules: [rawSchedule(PLAY_TIME)],
            });
            const result = unwrapOk(await readCurrentGame(chain));

            expect(result.durations.registration).toBe(7_200);
            expect(calls.some((call) => call.entry === "DefaultPhaseDurations")).toBe(true);
            // And the fallback durations are the ones the projection used.
            expect(result.upcoming[0]?.timeline.registrationStarts).toBe(
                PLAY_TIME - 1_200 - 600 - 7_200,
            );
        });
    });

    describe("failures", () => {
        test("an unknown game state arrives as a decode error", async () => {
            const { chain } = fakeChain({
                game: rawGame({ state: { type: "Reshuffling" } }),
                stored: STORED,
            });
            const error = unwrapErr(await readCurrentGame(chain));
            expect(isErrorOf(error, IndividualityDecodeError)).toBe(true);
        });

        test.each(["GameIndex", "Game", "GameSchedules", "StoredPhaseDurations", "block"] as const)(
            "a transport failure on %s arrives on the err channel with its cause",
            async (failOn) => {
                const { chain } = fakeChain({ game: rawGame(), stored: STORED, failOn });
                const error = unwrapErr(await readCurrentGame(chain));

                expect(error).toBeInstanceOf(ProductIndividualityError);
                expect((error.cause as Error).message).toBe(`${failOn} unreachable`);
            },
        );

        test("a failure reading the fallback constant also arrives on the err channel", async () => {
            // Only reachable when storage holds no override, which is why this
            // case is separate from the table above.
            const { chain } = fakeChain({ game: rawGame(), failOn: "constant" });
            const error = unwrapErr(await readCurrentGame(chain));
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });

        test("an already-aborted signal costs no round trip", async () => {
            const { chain, calls } = fakeChain({ game: rawGame(), stored: STORED });
            const controller = new AbortController();
            controller.abort();

            const error = unwrapErr(await readCurrentGame(chain, { signal: controller.signal }));
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(calls).toHaveLength(0);
        });
    });
}
