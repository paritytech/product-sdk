// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Subscriptions to the game, one registration and one participant record, at the
 * best block, decoded by the same functions the pinned reads use.
 *
 * Each watch returns the function that stops it. A value that fails to decode goes
 * to `onError` and the watch keeps running, while a failed subscription goes to
 * `onError` and ends. Nothing arrives after the stop function is called.
 *
 * PAPI emits once per best block whether or not the value changed, measured against
 * paseo on 2026-09-25, so a watch only delivers a value that differs from the last.
 *
 * ```ts
 * const stop = watchCurrentGame(
 *     chain,
 *     (game, block) => render(game, block.blockNumber),
 *     (error) => console.error(error),
 * );
 * ```
 *
 * The best block can still be reorganized away, and PAPI handles that by emitting
 * again. Read anything that must not be undone with the pinned reads instead.
 */
import { normalizeError } from "@parity/result";
import { toPersonhoodParticipant, type RawParticipant } from "./decode.js";
import { ProductIndividualityError } from "./errors.js";
import { toCurrentGame, type RawGameInfo } from "./game-decode.js";
import type { CurrentGame } from "./game-types.js";
import type { PlayerKey } from "./player-key.js";
import type { PersonhoodParticipant } from "./types.js";

/** The block a watched value was read at, which is a best block, not a finalized one. */
export interface WatchedBlock {
    blockHash: string;
    blockNumber: number;
}

/** A PAPI `watchValue` observable, narrowed to the one method a watch calls. */
export interface WatchedValue<Value> {
    subscribe(observer: {
        next: (emission: { block: { hash: string; number: number }; value: Value }) => void;
        error: (error: unknown) => void;
    }): { unsubscribe(): void };
}

/** Options every watch takes: only the best block, so a change shows before finality. */
export interface WatchAt {
    at: "best";
}

/** Structural, so a test double satisfies it. */
export interface CurrentGameWatchChain {
    individuality: {
        query: {
            Game: {
                Game: { watchValue(options: WatchAt): WatchedValue<RawGameInfo | undefined> };
            };
        };
    };
}

export interface PlayerWatchChain {
    individuality: {
        query: {
            Game: {
                Players: {
                    watchValue: (
                        key: PlayerKey,
                        options: WatchAt,
                    ) => WatchedValue<{ registered: boolean } | undefined>;
                };
            };
        };
    };
}

export interface ParticipantWatchChain {
    individuality: {
        query: {
            Score: {
                Participants: {
                    watchValue: (
                        key: PlayerKey,
                        options: WatchAt,
                    ) => WatchedValue<RawParticipant | undefined>;
                };
            };
        };
    };
}

/** Options for {@link watchPlayer} and {@link watchParticipant}. */
export interface WatchPlayerOptions {
    player: PlayerKey;
}

/** A player record in `Game.Players`, present from the first sign-up until archival. */
export interface PlayerRecord {
    /** Signed up for the current game. */
    registered: boolean;
}

export type WatchErrorHandler = (error: ProductIndividualityError) => void;

/** `Game.Game`, which is `null` between games. */
export function watchCurrentGame(
    chain: CurrentGameWatchChain,
    onValue: (game: CurrentGame | null, block: WatchedBlock) => void,
    onError: WatchErrorHandler,
): () => void {
    return watch(
        chain.individuality.query.Game.Game.watchValue({ at: "best" }),
        (raw) => (raw === undefined ? null : toCurrentGame(raw)),
        onValue,
        onError,
    );
}

/** `Game.Players`, which is `null` for a player who never signed up or was archived. */
export function watchPlayer(
    chain: PlayerWatchChain,
    options: WatchPlayerOptions,
    onValue: (record: PlayerRecord | null, block: WatchedBlock) => void,
    onError: WatchErrorHandler,
): () => void {
    return watch(
        chain.individuality.query.Game.Players.watchValue(options.player, { at: "best" }),
        (raw) => (raw === undefined ? null : { registered: raw.registered }),
        onValue,
        onError,
    );
}

/** `Score.Participants`, which is `null` for a player who has never been scored. */
export function watchParticipant(
    chain: ParticipantWatchChain,
    options: WatchPlayerOptions,
    onValue: (participant: PersonhoodParticipant | null, block: WatchedBlock) => void,
    onError: WatchErrorHandler,
): () => void {
    return watch(
        chain.individuality.query.Score.Participants.watchValue(options.player, { at: "best" }),
        (raw) => (raw === undefined ? null : toPersonhoodParticipant(raw)),
        onValue,
        onError,
    );
}

function watch<Raw, Value>(
    source: WatchedValue<Raw>,
    decode: (raw: Raw) => Value,
    onValue: (value: Value, block: WatchedBlock) => void,
    onError: WatchErrorHandler,
): () => void {
    let stopped = false;
    let last: string | undefined;
    const subscription = source.subscribe({
        next: ({ block, value }) => {
            if (stopped) return;
            const key = fingerprint(value);
            if (key === last) return;
            last = key;
            let decoded: Value;
            try {
                decoded = decode(value);
            } catch (cause) {
                onError(normalizeError(cause, ProductIndividualityError));
                return;
            }
            onValue(decoded, { blockHash: block.hash, blockNumber: block.number });
        },
        error: (cause) => {
            if (!stopped) onError(normalizeError(cause, ProductIndividualityError));
        },
    });
    return () => {
        stopped = true;
        subscription.unsubscribe();
    };
}

/** Storage values are plain data, and bigint is the one type JSON cannot carry. */
function fingerprint(value: unknown): string {
    return value === undefined
        ? "undefined"
        : JSON.stringify(value, (_, inner) =>
              typeof inner === "bigint" ? `${inner.toString()}n` : inner,
          );
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { Enum } = await import("polkadot-api");
    const { IndividualityDecodeError } = await import("./errors.js");

    const BLOCK = { hash: `0x${"ab".repeat(32)}`, number: 10 };
    const AT = { blockHash: BLOCK.hash, blockNumber: BLOCK.number };
    const PLAYER: PlayerKey = Enum("Account", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");

    /** A hand-driven observable that records how it was subscribed and stopped. */
    function source<Value>() {
        let observer:
            | {
                  next: (emission: { block: typeof BLOCK; value: Value }) => void;
                  error: (error: unknown) => void;
              }
            | undefined;
        const unsubscribe = vi.fn();
        const value: WatchedValue<Value> = {
            subscribe(next) {
                observer = next;
                return { unsubscribe };
            },
        };
        return {
            value,
            unsubscribe,
            emit: (emitted: Value, block = BLOCK) => observer?.next({ block, value: emitted }),
            fail: (error: unknown) => observer?.error(error),
        };
    }

    const rawGame = (overrides: Partial<RawGameInfo> = {}): RawGameInfo => ({
        index: 41,
        registration_ends: 1_000,
        shuffle_deadline: 2_000,
        game_date: 3_000,
        report_ends: 4_000,
        state: { type: "Reporting", value: { player_count: 6 } },
        max_group_size: 3,
        rounds: 2,
        pending_attendance: 6,
        airdrops_scheduled: 1,
        ...overrides,
    });

    function gameChain() {
        const game = source<RawGameInfo | undefined>();
        const options: unknown[] = [];
        const chain: CurrentGameWatchChain = {
            individuality: {
                query: {
                    Game: {
                        Game: {
                            watchValue(at) {
                                options.push(at);
                                return game.value;
                            },
                        },
                    },
                },
            },
        };
        return { chain, game, options };
    }

    describe("watchCurrentGame", () => {
        test("decodes each emission with toCurrentGame, and reports its block", () => {
            const { chain, game, options } = gameChain();
            const onValue = vi.fn();
            watchCurrentGame(chain, onValue, vi.fn());
            game.emit(rawGame());
            expect(options).toEqual([{ at: "best" }]);
            expect(onValue).toHaveBeenCalledWith(toCurrentGame(rawGame()), AT);
            expect(onValue.mock.calls[0]?.[0]).toMatchObject({
                phase: "Reporting",
                playerCount: 6,
            });
        });

        test("is null between games", () => {
            const { chain, game } = gameChain();
            const onValue = vi.fn();
            watchCurrentGame(chain, onValue, vi.fn());
            game.emit(undefined);
            expect(onValue).toHaveBeenCalledWith(null, AT);
        });

        test("sends a value that fails to decode to onError, and keeps watching", () => {
            const { chain, game } = gameChain();
            const onValue = vi.fn();
            const onError = vi.fn();
            watchCurrentGame(chain, onValue, onError);
            game.emit(rawGame({ state: { type: "Reshuffling" } }));
            game.emit(rawGame());
            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(IndividualityDecodeError);
            expect(onValue).toHaveBeenCalledTimes(1);
        });

        test("sends a failed subscription to onError as a package error with its cause", () => {
            const { chain, game } = gameChain();
            const onError = vi.fn();
            watchCurrentGame(chain, vi.fn(), onError);
            game.fail(new Error("disconnected"));
            const error = onError.mock.calls[0]?.[0] as ProductIndividualityError;
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect((error.cause as Error).message).toBe("disconnected");
        });

        test("delivers a value once, however many blocks repeat it", () => {
            const { chain, game } = gameChain();
            const onValue = vi.fn();
            watchCurrentGame(chain, onValue, vi.fn());
            game.emit(undefined);
            game.emit(undefined, { hash: `0x${"cd".repeat(32)}`, number: 11 });
            game.emit(rawGame(), { hash: `0x${"ef".repeat(32)}`, number: 12 });
            game.emit(rawGame(), { hash: `0x${"12".repeat(32)}`, number: 13 });
            expect(
                onValue.mock.calls.map(([value, block]) => [
                    value?.index ?? null,
                    block.blockNumber,
                ]),
            ).toEqual([
                [null, 10],
                [41, 12],
            ]);
        });

        test("reports a value that fails to decode once, not once per block", () => {
            const { chain, game } = gameChain();
            const onError = vi.fn();
            watchCurrentGame(chain, vi.fn(), onError);
            game.emit(rawGame({ state: { type: "Reshuffling" } }));
            game.emit(rawGame({ state: { type: "Reshuffling" } }));
            expect(onError).toHaveBeenCalledTimes(1);
        });

        test("stops the subscription, and delivers nothing after it", () => {
            const { chain, game } = gameChain();
            const onValue = vi.fn();
            const onError = vi.fn();
            const stop = watchCurrentGame(chain, onValue, onError);
            stop();
            game.emit(rawGame());
            game.fail(new Error("late"));
            expect(game.unsubscribe).toHaveBeenCalledTimes(1);
            expect(onValue).not.toHaveBeenCalled();
            expect(onError).not.toHaveBeenCalled();
        });
    });

    describe("watchPlayer", () => {
        function playerChain() {
            const players = source<{ registered: boolean } | undefined>();
            const keys: unknown[] = [];
            const chain: PlayerWatchChain = {
                individuality: {
                    query: {
                        Game: {
                            Players: {
                                watchValue: (key, at) => {
                                    keys.push([key, at]);
                                    return players.value;
                                },
                            },
                        },
                    },
                },
            };
            return { chain, players, keys };
        }

        test("watches the key as given, at the best block", () => {
            const { chain, keys } = playerChain();
            watchPlayer(chain, { player: PLAYER }, vi.fn(), vi.fn());
            expect(keys).toEqual([[PLAYER, { at: "best" }]]);
        });

        test("keeps only the registration, and is null without a record", () => {
            const { chain, players } = playerChain();
            const onValue = vi.fn();
            watchPlayer(chain, { player: PLAYER }, onValue, vi.fn());
            players.emit({ registered: true, first_game: 3 } as { registered: boolean });
            players.emit(undefined);
            expect(onValue.mock.calls).toEqual([
                [{ registered: true }, AT],
                [null, AT],
            ]);
        });
    });

    describe("watchParticipant", () => {
        const raw: RawParticipant = {
            score: 4,
            streak: { type: "Attended", value: 2 },
            attendance_history: 0b11,
            reached_personhood: false,
            has_ever_reached_personhood: false,
            recognition: { type: "NotRecognized" },
            last_attended_game: 40,
        };

        function participantChain() {
            const participants = source<RawParticipant | undefined>();
            const keys: unknown[] = [];
            const chain: ParticipantWatchChain = {
                individuality: {
                    query: {
                        Score: {
                            Participants: {
                                watchValue: (key, at) => {
                                    keys.push([key, at]);
                                    return participants.value;
                                },
                            },
                        },
                    },
                },
            };
            return { chain, participants, keys };
        }

        test("decodes each emission with toPersonhoodParticipant, and is null without a record", () => {
            const { chain, participants, keys } = participantChain();
            const onValue = vi.fn();
            watchParticipant(chain, { player: PLAYER }, onValue, vi.fn());
            participants.emit(raw);
            participants.emit(undefined);
            expect(keys).toEqual([[PLAYER, { at: "best" }]]);
            expect(onValue.mock.calls).toEqual([
                [toPersonhoodParticipant(raw), AT],
                [null, AT],
            ]);
        });

        test("tells values apart by their bigint payloads too", () => {
            const { chain, participants } = participantChain();
            const onValue = vi.fn();
            watchParticipant(chain, { player: PLAYER }, onValue, vi.fn());
            participants.emit({ ...raw, recognition: { type: "Recognized", value: 1n } });
            participants.emit({ ...raw, recognition: { type: "Recognized", value: 1n } });
            participants.emit({ ...raw, recognition: { type: "Recognized", value: 2n } });
            expect(onValue).toHaveBeenCalledTimes(2);
        });

        test("sends an unknown recognition to onError", () => {
            const { chain, participants } = participantChain();
            const onError = vi.fn();
            watchParticipant(chain, { player: PLAYER }, vi.fn(), onError);
            participants.emit({ ...raw, recognition: { type: "Provisional" } });
            expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(IndividualityDecodeError);
        });
    });
}
