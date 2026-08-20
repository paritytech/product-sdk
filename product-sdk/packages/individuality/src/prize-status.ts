// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * "Did I win anything, and can I still claim it" — the composed read behind
 * `getDailyPrizeStatus`. The game gives an index and a draw count, the count gives
 * the event ids, each id gives a draw.
 *
 * **One function because the pinning is:** the two inner reads each pin their own
 * block when called alone, so composing them by hand reads two.
 *
 * **The draw count is the difficulty.** It lives on `Game.Game`, which holds only
 * the running game, but a claim outlives its game — hence
 * {@link ReadPrizeStatusOptions.game}, and no probe fallback: probing cannot tell a
 * cleaned-up draw from one never scheduled, and a short answer reads as "you won
 * nothing".
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { runDrawRead, type AirdropChain } from "./airdrop-read.js";
import { gameAirdropEventIds } from "./airdrop-ids.js";
import type { AirdropDraw, AirdropRegistrant } from "./airdrop-types.js";
import { ProductIndividualityError } from "./errors.js";
import { runGameRead, type GameChain } from "./game-read.js";
import type { CurrentGame, GameSchedulePreview } from "./game-types.js";
import { pinBlock } from "./pinned.js";
import type { FinalizedSnapshot } from "./types.js";

/** Both halves of the chain surface, since this read spans `Game` and `Airdrop`. */
export type PrizeStatusChain = AirdropChain & GameChain;

/** A game identified by the caller rather than read from the chain. */
export interface CapturedGame {
    index: number;
    /**
     * `airdrops_scheduled` as it was while the game ran. Capture it then: it is
     * unreadable afterwards, and it is the count that actually got scheduled
     * rather than what the schedule asked for.
     */
    airdropsScheduled: number;
}

/** Options for {@link readPrizeStatus}. */
export interface ReadPrizeStatusOptions {
    /**
     * Whose outcome to report. Omit to read the draws without asking about
     * anyone, which leaves every outcome `Unchecked`.
     */
    registrant?: AirdropRegistrant;
    /**
     * A game the caller already knows, for claiming after it ended. Supplying it
     * **skips the game read** — four fewer reads, so `game` on the result is `null`
     * even if this index is the running one.
     */
    game?: CapturedGame;
    signal?: AbortSignal;
}

/** The outcome of a prize-status read. */
export type PrizeStatus =
    /**
     * No game is running and the caller named none, so there are no draws to
     * report. Carries the upcoming schedule, which is the useful answer here.
     */
    | { tag: "NoGame"; at: FinalizedSnapshot; upcoming: GameSchedulePreview[] }
    /** A game's draws, in airdrop-index order. */
    | {
          tag: "Draws";
          at: FinalizedSnapshot;
          gameIndex: number;
          /**
           * Where the draw count came from. `"caller"` means the count was
           * supplied and the chain was not asked to confirm it — a wrong count
           * silently shortens or pads this list.
           */
          drawCountFrom: "chain" | "caller";
          /**
           * The running game, when these draws belong to it. `null` for a
           * caller-supplied game, whose read is skipped.
           */
          game: CurrentGame | null;
          /** One entry per scheduled draw. Empty when the game scheduled none. */
          draws: AirdropDraw[];
      };

/**
 * **Not an authorization oracle.** The chain re-checks eligibility on claim, and a
 * backend trusting a `Won` here is trivially spoofed.
 *
 * `Game.airdrop_event_id_base` escapes the pinned block — PAPI serves constants from
 * the client's runtime — so it can only disagree across an upgrade mid-read.
 */
export async function readPrizeStatus(
    chain: PrizeStatusChain,
    options: ReadPrizeStatusOptions = {},
): Promise<Result<PrizeStatus, ProductIndividualityError>> {
    try {
        return ok(await runPrizeStatusRead(chain, options));
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** Throws; {@link readPrizeStatus} owns the `Result` boundary. */
async function runPrizeStatusRead(
    chain: PrizeStatusChain,
    options: ReadPrizeStatusOptions,
): Promise<PrizeStatus> {
    const { registrant, game: captured, signal } = options;

    // Pinned once here and handed to every inner read, which is the only reason
    // this composition is safe to make.
    const snapshot = await pinBlock(chain, signal);

    const resolved = await resolveGame(chain, captured, snapshot, signal);
    if (resolved.tag === "NoGame") {
        return { tag: "NoGame", at: snapshot, upcoming: resolved.upcoming };
    }

    const base = await chain.individuality.constants.Game.airdrop_event_id_base();
    const eventIds = gameAirdropEventIds({
        base,
        gameIndex: resolved.index,
        airdropsScheduled: resolved.airdropsScheduled,
    });

    // Fanned out rather than sequential: the draws are independent point reads
    // against a block that is already pinned, so ordering buys nothing.
    const draws = await Promise.all(
        eventIds.map((eventId) => runDrawRead(chain, { eventId, registrant, signal }, snapshot)),
    );

    return {
        tag: "Draws",
        at: snapshot,
        gameIndex: resolved.index,
        drawCountFrom: resolved.drawCountFrom,
        game: resolved.game,
        draws,
    };
}

/** Which game's draws to report, and where its count came from. */
type ResolvedGame =
    | { tag: "NoGame"; upcoming: GameSchedulePreview[] }
    | {
          tag: "Game";
          index: number;
          airdropsScheduled: number;
          drawCountFrom: "chain" | "caller";
          game: CurrentGame | null;
      };

async function resolveGame(
    chain: PrizeStatusChain,
    captured: CapturedGame | undefined,
    snapshot: FinalizedSnapshot,
    signal: AbortSignal | undefined,
): Promise<ResolvedGame> {
    if (captured !== undefined) {
        // The caller knows the game, so the four game reads would tell us nothing
        // we are going to use.
        return {
            tag: "Game",
            index: captured.index,
            airdropsScheduled: captured.airdropsScheduled,
            drawCountFrom: "caller",
            game: null,
        };
    }

    const current = await runGameRead(chain, { signal }, snapshot);
    if (current.tag === "BetweenGames") {
        // `lastGameIndex` names the game that just ended, but not its draw count,
        // so it cannot stand in for a captured game. Reporting no draws here is
        // honest; guessing a count would not be.
        return { tag: "NoGame", upcoming: current.upcoming };
    }

    return {
        tag: "Game",
        index: current.game.index,
        airdropsScheduled: current.game.airdropsScheduled,
        drawCountFrom: "chain",
        game: current.game,
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapOk, unwrapErr } = await import("@parity/result");
    const { GAME_AIRDROP_EVENT_ID_BASE, gameAirdropEventId } = await import("./airdrop-ids.js");

    const BLOCK = { hash: `0x${"77".repeat(32)}`, number: 4_242 };
    const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const PLAY_TIME = 1_800_000_000;
    const TICKET = `0x${"ee".repeat(32)}`;

    const eventId = (gameIndex: number, airdropIndex: number) =>
        gameAirdropEventId({ base: GAME_AIRDROP_EVENT_ID_BASE, gameIndex, airdropIndex });

    interface FakeState {
        /** Omit to put the chain between games. */
        game?: { index: number; airdropsScheduled: number };
        /** Event ids that hold a winning entry for ALICE. */
        wins?: string[];
        schedules?: number[];
    }

    /**
     * A double spanning both halves of the surface, recording every read's block.
     *
     * The block is what most of this suite is about: a composition that pins per
     * inner read still satisfies every value assertion.
     */
    function fakeChain(state: FakeState) {
        const blocks: string[] = [];
        let pins = 0;
        const seen = (options: { at: string; signal?: AbortSignal }) => {
            options.signal?.throwIfAborted();
            blocks.push(options.at);
        };

        const chain: PrizeStatusChain = {
            individuality: {
                constants: {
                    Game: {
                        airdrop_event_id_base: async () => GAME_AIRDROP_EVENT_ID_BASE,
                        DefaultPhaseDurations: async () => ({
                            registration: 3_600,
                            shuffle: 600,
                            post_shuffle_margin: 300,
                            reporting: 1_800,
                            player_process: 900,
                        }),
                    },
                },
                query: {
                    Game: {
                        GameIndex: {
                            getValue: async (o) => {
                                seen(o);
                                return state.game?.index ?? 40;
                            },
                        },
                        Game: {
                            getValue: async (o) => {
                                seen(o);
                                return state.game === undefined
                                    ? undefined
                                    : {
                                          index: state.game.index,
                                          registration_ends: PLAY_TIME - 900,
                                          shuffle_deadline: PLAY_TIME - 300,
                                          game_date: PLAY_TIME,
                                          report_ends: PLAY_TIME + 1_800,
                                          // A GameState variant, not an Airdrop
                                          // Status one — the two enums share
                                          // several names but not this one.
                                          state: { type: "Reporting" },
                                          max_group_size: 5,
                                          rounds: 3,
                                          pending_attendance: 0,
                                          airdrops_scheduled: state.game.airdropsScheduled,
                                      };
                            },
                        },
                        GameSchedules: {
                            getValue: async (o) => {
                                seen(o);
                                return (state.schedules ?? []).map((t) => ({
                                    game_play_time: t,
                                    rounds: 3,
                                    max_group_size: 5,
                                    airdrops: [],
                                }));
                            },
                        },
                        StoredPhaseDurations: {
                            getValue: async (o) => {
                                seen(o);
                                return undefined;
                            },
                        },
                    },
                    Airdrop: {
                        Events: {
                            getValue: async (id, o) => {
                                seen(o);
                                return {
                                    id,
                                    info: {
                                        prize: {
                                            asset_id: {
                                                parents: 1,
                                                interior: { type: "Here", value: undefined },
                                            },
                                            asset_amount: 100n,
                                            max_winners: 5,
                                            winner_cap: 10_000,
                                        },
                                        registration_starts: 1n,
                                        draw_time: 2n,
                                        end_time: 3n,
                                    },
                                    status: {
                                        type: "Claiming",
                                        value: {
                                            total_participants: 9,
                                            effective_winners: 2,
                                            claimed: 1,
                                        },
                                    },
                                };
                            },
                        },
                        Winners: {
                            getValue: async (id, _entry, o) => {
                                seen(o);
                                return state.wins?.includes(id) ? TICKET : undefined;
                            },
                        },
                        EventEntropy: {
                            getValue: async (_id, o) => {
                                seen(o);
                                return undefined;
                            },
                        },
                        Registrations: {
                            getEntries: async (_id, o) => {
                                seen(o);
                                return [];
                            },
                        },
                    },
                },
            },
            raw: {
                individuality: {
                    getFinalizedBlock: async () => {
                        pins += 1;
                        return BLOCK;
                    },
                },
            },
        };
        return { chain, blocks: () => blocks, pins: () => pins };
    }

    describe("readPrizeStatus, on the running game", () => {
        test("reports one draw per scheduled airdrop, in index order", async () => {
            const { chain } = fakeChain({ game: { index: 41, airdropsScheduled: 3 } });
            const status = unwrapOk(await readPrizeStatus(chain));

            expect(status.tag).toBe("Draws");
            if (status.tag !== "Draws") return;
            expect(status.gameIndex).toBe(41);
            expect(status.drawCountFrom).toBe("chain");
            expect(status.draws.map((d) => d.eventId)).toEqual([
                eventId(41, 0),
                eventId(41, 1),
                eventId(41, 2),
            ]);
        });

        test("pins one block and reads everything at it", async () => {
            // The reason this function exists rather than a caller composing the
            // two reads: those pin one block each.
            const { chain, blocks, pins } = fakeChain({
                game: { index: 41, airdropsScheduled: 2 },
            });
            const status = unwrapOk(await readPrizeStatus(chain));

            expect(pins()).toBe(1);
            expect(new Set(blocks())).toEqual(new Set([BLOCK.hash]));
            expect(status.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
        });

        test("carries the running game alongside its draws", async () => {
            const { chain } = fakeChain({ game: { index: 41, airdropsScheduled: 1 } });
            const status = unwrapOk(await readPrizeStatus(chain));
            if (status.tag !== "Draws") throw new Error("expected Draws");

            expect(status.game?.index).toBe(41);
            expect(status.game?.phase).toBe("Reporting");
        });

        test("reports a win against the draw that holds it", async () => {
            const { chain } = fakeChain({
                game: { index: 41, airdropsScheduled: 3 },
                wins: [eventId(41, 1)],
            });
            const status = unwrapOk(
                await readPrizeStatus(chain, {
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            if (status.tag !== "Draws") throw new Error("expected Draws");

            expect(status.draws.map((d) => d.outcome.tag)).toEqual(["NotWon", "Won", "NotWon"]);
        });

        test("without a registrant every outcome is Unchecked, not NotWon", async () => {
            const { chain } = fakeChain({
                game: { index: 41, airdropsScheduled: 2 },
                wins: [eventId(41, 0)],
            });
            const status = unwrapOk(await readPrizeStatus(chain));
            if (status.tag !== "Draws") throw new Error("expected Draws");

            expect(status.draws.map((d) => d.outcome.tag)).toEqual(["Unchecked", "Unchecked"]);
        });

        test("a game with no draws is Draws with an empty list", async () => {
            // The game exists, it just scheduled nothing. Distinct from NoGame.
            const { chain } = fakeChain({ game: { index: 41, airdropsScheduled: 0 } });
            const status = unwrapOk(await readPrizeStatus(chain));

            expect(status.tag).toBe("Draws");
            if (status.tag !== "Draws") return;
            expect(status.draws).toEqual([]);
        });
    });

    describe("readPrizeStatus, on a caller-supplied game", () => {
        test("reports its draws without reading the game", async () => {
            // The past-game case, which is the ordinary one for a claim: the game
            // is gone and only the caller still knows its draw count.
            const { chain, blocks } = fakeChain({ wins: [eventId(7, 0)] });
            const status = unwrapOk(
                await readPrizeStatus(chain, {
                    game: { index: 7, airdropsScheduled: 1 },
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            if (status.tag !== "Draws") throw new Error("expected Draws");

            expect(status.gameIndex).toBe(7);
            expect(status.drawCountFrom).toBe("caller");
            expect(status.draws[0]?.outcome).toEqual({ tag: "Won", ticket: TICKET });
            // Three reads for the one draw, and none of the four game reads.
            expect(blocks()).toHaveLength(3);
        });

        test("game is null even though a different game is running", async () => {
            const { chain } = fakeChain({ game: { index: 41, airdropsScheduled: 2 } });
            const status = unwrapOk(
                await readPrizeStatus(chain, { game: { index: 7, airdropsScheduled: 1 } }),
            );
            if (status.tag !== "Draws") throw new Error("expected Draws");

            expect(status.game).toBeNull();
            expect(status.gameIndex).toBe(7);
        });

        test("a count above MAX_GAME_AIRDROPS arrives on the err channel", async () => {
            const { chain } = fakeChain({});
            const error = unwrapErr(
                await readPrizeStatus(chain, { game: { index: 7, airdropsScheduled: 17 } }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });
    });

    describe("readPrizeStatus, between games", () => {
        test("no running game and no captured one yields NoGame with the schedule", async () => {
            const { chain } = fakeChain({ schedules: [PLAY_TIME] });
            const status = unwrapOk(await readPrizeStatus(chain));

            expect(status.tag).toBe("NoGame");
            if (status.tag !== "NoGame") return;
            expect(status.upcoming.map((s) => s.gamePlayTime)).toEqual([PLAY_TIME]);
        });

        test("does not fall back to lastGameIndex", async () => {
            // The index is known there but the draw count is not, and a guessed
            // count would read as "you won nothing".
            const { chain, blocks } = fakeChain({});
            const status = unwrapOk(await readPrizeStatus(chain));

            expect(status.tag).toBe("NoGame");
            // Four game reads and no draw reads.
            expect(blocks()).toHaveLength(4);
        });
    });

    describe("failures", () => {
        test("an already-aborted signal costs no round trip", async () => {
            const { chain, blocks, pins } = fakeChain({
                game: { index: 41, airdropsScheduled: 2 },
            });
            const controller = new AbortController();
            controller.abort();

            const error = unwrapErr(await readPrizeStatus(chain, { signal: controller.signal }));
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(pins()).toBe(0);
            expect(blocks()).toHaveLength(0);
        });
    });
}
