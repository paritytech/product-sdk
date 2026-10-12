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
 * paseo on 2026-09-25, so a watch only delivers a decoded value that differs from the
 * last one it delivered.
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
import { jsonSerialize } from "polkadot-api/utils";
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

/** Distinct from every storage value, `undefined` included, so the first emission is decoded. */
const UNSEEN = Symbol("unseen");

function watch<Raw, Value>(
    source: WatchedValue<Raw>,
    decode: (raw: Raw) => Value,
    onValue: (value: Value, block: WatchedBlock) => void,
    onError: WatchErrorHandler,
): () => void {
    let stopped = false;
    let lastRaw: Raw | typeof UNSEEN = UNSEEN;
    let lastDelivered: string | undefined;
    const subscription = source.subscribe({
        next: ({ block, value }) => {
            // PAPI hands back the same object while the stored bytes are unchanged.
            if (stopped || value === lastRaw) return;
            lastRaw = value;
            let decoded: Value;
            try {
                decoded = decode(value);
            } catch (cause) {
                onError(normalizeError(cause, ProductIndividualityError));
                return;
            }
            // New bytes can decode to the same value when only a field the decoder
            // drops has moved, such as an offchain-worker cursor.
            const delivered = JSON.stringify(decoded, jsonSerialize);
            if (delivered === lastDelivered) return;
            lastDelivered = delivered;
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

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { Enum } = await import("polkadot-api");
    const { IndividualityDecodeError } = await import("./errors.js");

    const BLOCK = { hash: `0x${"ab".repeat(32)}`, number: 10 };
    const AT = { blockHash: BLOCK.hash, blockNumber: BLOCK.number };
    const PLAYER: PlayerKey = Enum("Account", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    const block = (number: number) => ({
        hash: `0x${number.toString(16).padStart(64, "0")}`,
        number,
    });

    /** A hand-driven observable that records how it was stopped. */
    function source<Value>() {
        let observer: Parameters<WatchedValue<Value>["subscribe"]>[0] | undefined;
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
            emit: (emitted: Value, at = BLOCK) => observer?.next({ block: at, value: emitted }),
            fail: (error: unknown) => observer?.error(error),
        };
    }

    function fakeChain() {
        const game = source<RawGameInfo | undefined>();
        const players = source<{ registered: boolean } | undefined>();
        const participants = source<RawParticipant | undefined>();
        const calls: unknown[][] = [];
        const chain: CurrentGameWatchChain & PlayerWatchChain & ParticipantWatchChain = {
            individuality: {
                query: {
                    Game: {
                        Game: {
                            watchValue(options) {
                                calls.push(["Game", options]);
                                return game.value;
                            },
                        },
                        Players: {
                            watchValue: (key, options) => {
                                calls.push(["Players", key, options]);
                                return players.value;
                            },
                        },
                    },
                    Score: {
                        Participants: {
                            watchValue: (key, options) => {
                                calls.push(["Participants", key, options]);
                                return participants.value;
                            },
                        },
                    },
                },
            },
        };
        return { chain, calls, game, players, participants };
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

    const rawParticipant = (overrides: Partial<RawParticipant> = {}): RawParticipant => ({
        score: 4,
        streak: { type: "Attended", value: 2 },
        attendance_history: 0b11,
        reached_personhood: false,
        has_ever_reached_personhood: false,
        recognition: { type: "NotRecognized" },
        last_attended_game: 40,
        ...overrides,
    });

    describe("watchCurrentGame", () => {
        test("decodes each emission with toCurrentGame at the best block, and reports its block", () => {
            const { chain, calls, game } = fakeChain();
            const onValue = vi.fn();
            watchCurrentGame(chain, onValue, vi.fn());
            game.emit(rawGame());
            expect(calls).toEqual([["Game", { at: "best" }]]);
            expect(onValue).toHaveBeenCalledWith(toCurrentGame(rawGame()), AT);
            expect(onValue.mock.calls[0]?.[0]).toMatchObject({
                phase: "Reporting",
                playerCount: 6,
            });
        });

        test("is null between games", () => {
            const { chain, game } = fakeChain();
            const onValue = vi.fn();
            watchCurrentGame(chain, onValue, vi.fn());
            game.emit(undefined);
            expect(onValue).toHaveBeenCalledWith(null, AT);
        });

        test("delivers a value once, however many blocks repeat it", () => {
            const { chain, game } = fakeChain();
            const onValue = vi.fn();
            watchCurrentGame(chain, onValue, vi.fn());
            const same = rawGame();
            game.emit(undefined);
            game.emit(undefined, block(11));
            game.emit(same, block(12));
            game.emit(same, block(13));
            game.emit(rawGame(), block(14));
            expect(
                onValue.mock.calls.map(([value, at]) => [value?.index ?? null, at.blockNumber]),
            ).toEqual([
                [null, 10],
                [41, 12],
            ]);
        });

        test("delivers nothing when only a cursor the decoder drops has moved", () => {
            const { chain, game } = fakeChain();
            const onValue = vi.fn();
            watchCurrentGame(chain, onValue, vi.fn());
            const cursor = (next_player_index: number) =>
                rawGame({
                    state: {
                        type: "Shuffle",
                        value: { step: { type: "Step2Retrieve", value: { next_player_index } } },
                    },
                });
            game.emit(cursor(1));
            game.emit(cursor(2), block(11));
            expect(onValue).toHaveBeenCalledTimes(1);
        });

        test("sends a value that fails to decode to onError once, and keeps watching", () => {
            const { chain, game } = fakeChain();
            const onValue = vi.fn();
            const onError = vi.fn();
            watchCurrentGame(chain, onValue, onError);
            const broken = rawGame({ state: { type: "Reshuffling" } });
            game.emit(broken);
            game.emit(broken, block(11));
            game.emit(rawGame(), block(12));
            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(IndividualityDecodeError);
            expect(onValue).toHaveBeenCalledTimes(1);
        });

        test("sends a failed subscription to onError as a package error with its cause", () => {
            const { chain, game } = fakeChain();
            const onError = vi.fn();
            watchCurrentGame(chain, vi.fn(), onError);
            game.fail(new Error("disconnected"));
            const error = onError.mock.calls[0]?.[0] as ProductIndividualityError;
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect((error.cause as Error).message).toBe("disconnected");
        });

        test("stops the subscription, and delivers nothing after it", () => {
            const { chain, game } = fakeChain();
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
        test("watches the key as given at the best block, keeping only the registration", () => {
            const { chain, calls, players } = fakeChain();
            const onValue = vi.fn();
            watchPlayer(chain, { player: PLAYER }, onValue, vi.fn());
            players.emit({ registered: true, first_game: 3 } as { registered: boolean });
            players.emit({ registered: true, first_game: 4 } as { registered: boolean }, block(11));
            players.emit(undefined, block(12));
            expect(calls).toEqual([["Players", PLAYER, { at: "best" }]]);
            expect(onValue.mock.calls).toEqual([
                [{ registered: true }, AT],
                [null, { blockHash: block(12).hash, blockNumber: 12 }],
            ]);
        });
    });

    describe("watchParticipant", () => {
        test("decodes each emission with toPersonhoodParticipant, and is null without a record", () => {
            const { chain, calls, participants } = fakeChain();
            const onValue = vi.fn();
            watchParticipant(chain, { player: PLAYER }, onValue, vi.fn());
            participants.emit(rawParticipant());
            participants.emit(undefined, block(11));
            expect(calls).toEqual([["Participants", PLAYER, { at: "best" }]]);
            expect(onValue.mock.calls).toEqual([
                [toPersonhoodParticipant(rawParticipant()), AT],
                [null, { blockHash: block(11).hash, blockNumber: 11 }],
            ]);
        });

        test("delivers a new score, but not a new recognition revision the decoder drops", () => {
            const { chain, participants } = fakeChain();
            const onValue = vi.fn();
            watchParticipant(chain, { player: PLAYER }, onValue, vi.fn());
            participants.emit(rawParticipant({ recognition: { type: "Recognized", value: 1n } }));
            participants.emit(
                rawParticipant({ recognition: { type: "Recognized", value: 2n } }),
                block(11),
            );
            participants.emit(
                rawParticipant({ score: 5, recognition: { type: "Recognized", value: 2n } }),
                block(12),
            );
            expect(onValue.mock.calls.map(([value]) => value?.score)).toEqual([4, 5]);
        });

        test("sends an unknown recognition to onError", () => {
            const { chain, participants } = fakeChain();
            const onError = vi.fn();
            watchParticipant(chain, { player: PLAYER }, vi.fn(), onError);
            participants.emit(rawParticipant({ recognition: { type: "Provisional" } }));
            expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(IndividualityDecodeError);
        });
    });
}
