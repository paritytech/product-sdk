// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The roster of the running game: the index a player holds each round, who shares
 * their group, and the key each player is reached on.
 *
 * **The roster exists only for part of a game.** The shuffle writes the indices and
 * `PlayerProcess::Step2ClearIndices` drains them, and that window is exactly when
 * `CurrentGame.playerCount` is not `null`. Read the game first, and derive anything
 * that has to outlive the game while it lasts, such as {@link readCreditCandidates}.
 *
 * The group arithmetic mirrors the pallet: `numberOfGroups` groups, and a player at
 * index `i` sits in group `i % numberOfGroups` with every index that shares it.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { hexToBytes } from "@parity/product-sdk-utils";
import { creditHash } from "./credits.js";
import { IndividualityDecodeError, ProductIndividualityError } from "./errors.js";
import { toCurrentGame, type RawGameInfo } from "./game-decode.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import type { PlayerKey } from "./player-key.js";
import type { FinalizedSnapshot } from "./types.js";

/**
 * Structural, so a test double satisfies it. Matched by hand against the paseo
 * descriptors on 2026-09-25:
 *
 * ```
 * Game.PlayerToIndex:            StorageDescriptor<[Key: AccountOrPerson], Array<number>, true, never>
 * Game.IndexToPlayer:            StorageDescriptor<[Key: [number, number]], AccountOrPerson, true, never>
 * Game.CommunicationIdentifiers: StorageDescriptor<[Key: SS58String], SizedHex<65>, true, never>
 * ```
 */
export interface RosterChain extends PinnedChain {
    individuality: {
        query: {
            Game: {
                /** Element `r` is the player index in round `r`. */
                PlayerToIndex: {
                    getValue: (key: PlayerKey, options: ReadAt) => Promise<number[] | undefined>;
                };
                /** Keyed by `[round, index]`. */
                IndexToPlayer: {
                    getValues: (
                        keys: Array<[[number, number]]>,
                        options: ReadAt,
                    ) => Promise<Array<PlayerKey | undefined>>;
                };
                CommunicationIdentifiers: {
                    getValue(account: string, options: ReadAt): Promise<string | undefined>;
                };
            };
        };
    };
}

/** {@link RosterChain} plus the game, which {@link readCreditCandidates} reads at the same block. */
export type CreditCandidatesChain = RosterChain & {
    individuality: {
        query: {
            Game: {
                Game: { getValue(options: ReadAt): Promise<RawGameInfo | undefined> };
            };
        };
    };
};

/** One position of a group, with whether a player was shuffled into it. */
export interface GroupSeat {
    index: number;
    occupied: boolean;
}

/** One occupied seat, resolved to the player the chain keys it by. */
export interface GroupMember {
    index: number;
    player: PlayerKey;
}

/** The groups a roster of `playerCount` splits into, `0` when there is no roster. */
export function numberOfGroups(playerCount: number, maxGroupSize: number): number {
    if (playerCount <= 0 || maxGroupSize <= 0) return 0;
    return Math.ceil(playerCount / maxGroupSize);
}

/**
 * All `maxGroupSize` seats of the group the player at `playerIndex` sits in,
 * ascending by index.
 *
 * A seat whose index reaches past `playerCount` is unoccupied. Filtering those out
 * leaves the member list the pallet itself computes.
 */
export function groupSeats(
    playerIndex: number,
    playerCount: number,
    maxGroupSize: number,
): GroupSeat[] {
    const groups = numberOfGroups(playerCount, maxGroupSize);
    if (groups === 0) return [];
    const group = playerIndex % groups;
    return Array.from({ length: maxGroupSize }, (_, seat) => {
        const index = group + seat * groups;
        return { index, occupied: index < playerCount };
    });
}

/** Options for {@link readPlayerIndices}. */
export interface ReadPlayerIndicesOptions {
    player: PlayerKey;
    signal?: AbortSignal;
}

export interface PlayerIndicesResult {
    at: FinalizedSnapshot;
    /** One index per round, or `null` when the player holds no seat in the roster. */
    indices: number[] | null;
}

/** The index a player holds in each round, at one pinned finalized block. */
export async function readPlayerIndices(
    chain: RosterChain,
    options: ReadPlayerIndicesOptions,
): Promise<Result<PlayerIndicesResult, ProductIndividualityError>> {
    try {
        const snapshot = await pinBlock(chain, options.signal);
        const indices = await chain.individuality.query.Game.PlayerToIndex.getValue(
            options.player,
            readAt(snapshot, options.signal),
        );
        return ok({ at: snapshot, indices: indices ?? null });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** Options for {@link readGroupMembers}. */
export interface ReadGroupMembersOptions {
    round: number;
    /** The index of the player whose group to read, in that round. */
    ownIndex: number;
    /** From `CurrentGame.playerCount`. */
    playerCount: number;
    maxGroupSize: number;
    signal?: AbortSignal;
}

export interface GroupMembersResult {
    at: FinalizedSnapshot;
    /** Every occupied seat, the player at `ownIndex` included, ascending by index. */
    members: GroupMember[];
}

/**
 * The members of one group in one round, at one pinned finalized block.
 *
 * An occupied seat with no player behind it means the counts and the indices come
 * from different shuffles, or the indices are already being drained, and arrives on
 * the `err` channel.
 */
export async function readGroupMembers(
    chain: RosterChain,
    options: ReadGroupMembersOptions,
): Promise<Result<GroupMembersResult, ProductIndividualityError>> {
    try {
        const { round, ownIndex, playerCount, maxGroupSize, signal } = options;
        if (ownIndex >= playerCount) {
            throw new ProductIndividualityError(
                "a group member index must be below the player count",
            );
        }
        const snapshot = await pinBlock(chain, signal);
        const seats = groupSeats(ownIndex, playerCount, maxGroupSize).filter(
            (seat) => seat.occupied,
        );
        const players = await chain.individuality.query.Game.IndexToPlayer.getValues(
            seats.map((seat) => [[round, seat.index]]),
            readAt(snapshot, signal),
        );
        return ok({
            at: snapshot,
            members: seats.map((seat, i) => ({ index: seat.index, player: seated(players[i]) })),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

function seated(player: PlayerKey | undefined): PlayerKey {
    if (player === undefined) {
        throw new ProductIndividualityError(
            "the roster holds no player at a seat the player count says is taken",
        );
    }
    return player;
}

/** Options for {@link readCommunicationIdentifier}. */
export interface ReadCommunicationIdentifierOptions {
    /** SS58. Only accounts register one, an alias never does. */
    account: string;
    signal?: AbortSignal;
}

export interface CommunicationIdentifierResult {
    at: FinalizedSnapshot;
    /**
     * The 65 bytes the account registered at sign-up, or `null` when it has none.
     * The chain never interprets them, and deriving them stays with the product.
     */
    identifier: Uint8Array | null;
}

const IDENTIFIER_HEX = /^0x[0-9a-fA-F]{130}$/;

/** The key an account is reached on during the game, at one pinned finalized block. */
export async function readCommunicationIdentifier(
    chain: RosterChain,
    options: ReadCommunicationIdentifierOptions,
): Promise<Result<CommunicationIdentifierResult, ProductIndividualityError>> {
    try {
        const snapshot = await pinBlock(chain, options.signal);
        const raw = await chain.individuality.query.Game.CommunicationIdentifiers.getValue(
            options.account,
            readAt(snapshot, options.signal),
        );
        if (raw !== undefined && !IDENTIFIER_HEX.test(raw)) {
            throw new IndividualityDecodeError("communication identifier is not 65 bytes of hex");
        }
        return ok({
            at: snapshot,
            identifier: raw === undefined ? null : hexToBytes(raw.slice(2)),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** One credit the attestee could earn this game: a co-player of one round, and the hash. */
export interface CreditCandidate {
    round: number;
    attesterIndex: number;
    /** Exactly as the chain keys the co-player, which is the form the hash is built from. */
    attester: PlayerKey;
    /** The credit, as {@link creditHash} derives it. */
    hash: string;
}

/** Options for {@link readCreditCandidates}. */
export interface ReadCreditCandidatesOptions {
    attestee: PlayerKey;
    signal?: AbortSignal;
}

export interface CreditCandidatesResult {
    at: FinalizedSnapshot;
    /** The game the candidates belong to, or `null` when no game has a roster at this block. */
    gameIndex: number | null;
    /** Ascending by round, then by attester index. Empty when the attestee holds no seat. */
    candidates: CreditCandidate[];
}

/**
 * Every credit the attestee could earn in the running game, one per co-player per
 * round, with the game and the roster read at one pinned finalized block.
 *
 * Deriving is what names the attester behind each credit, and it is the only way to
 * see the credits that have not been awarded yet. Match the hashes against
 * `readCredits` to tell the two apart. The roster is drained when the game ends, so
 * cache the result if it has to outlive the game.
 */
export async function readCreditCandidates(
    chain: CreditCandidatesChain,
    options: ReadCreditCandidatesOptions,
): Promise<Result<CreditCandidatesResult, ProductIndividualityError>> {
    try {
        const { attestee, signal } = options;
        const query = chain.individuality.query.Game;
        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);

        const [game, indices] = await Promise.all([
            query.Game.getValue(at),
            query.PlayerToIndex.getValue(attestee, at),
        ]);
        const playerCount = game === undefined ? null : toCurrentGame(game).playerCount;
        if (game === undefined || playerCount === null) {
            return ok({ at: snapshot, gameIndex: null, candidates: [] });
        }
        if (indices === undefined) {
            return ok({ at: snapshot, gameIndex: game.index, candidates: [] });
        }

        const seats = indices.slice(0, game.rounds).flatMap((ownIndex, round) => {
            if (ownIndex >= playerCount) {
                throw new ProductIndividualityError("a player index lies outside the roster");
            }
            return groupSeats(ownIndex, playerCount, game.max_group_size)
                .filter((seat) => seat.occupied && seat.index !== ownIndex)
                .map((seat) => ({ round, index: seat.index }));
        });
        const attesters = await query.IndexToPlayer.getValues(
            seats.map((seat) => [[seat.round, seat.index]]),
            at,
        );

        return ok({
            at: snapshot,
            gameIndex: game.index,
            candidates: seats.map((seat, i) => {
                const attester = seated(attesters[i]);
                return {
                    round: seat.round,
                    attesterIndex: seat.index,
                    attester,
                    hash: creditHash({
                        gameIndex: game.index,
                        round: seat.round,
                        attester,
                        attestee,
                    }),
                };
            }),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapErr, unwrapOk } = await import("@parity/result");
    const { AccountId, Enum } = await import("polkadot-api");

    const BLOCK = { hash: `0x${"88".repeat(32)}`, number: 4_242 };
    const AT = { blockHash: BLOCK.hash, blockNumber: BLOCK.number };
    const player = (i: number): PlayerKey =>
        Enum("Account", AccountId().dec(new Uint8Array(32).fill(10 + i)));
    const keyOf = (key: PlayerKey) => `${key.type}:${key.value}`;
    const members = (playerIndex: number, playerCount: number, maxGroupSize: number) =>
        groupSeats(playerIndex, playerCount, maxGroupSize)
            .filter((seat) => seat.occupied)
            .map((seat) => seat.index);

    /** Seven players in groups of at most three, over two rounds. */
    const PLAYER_COUNT = 7;
    const MAX_GROUP_SIZE = 3;
    const seatedAt = (round: number, index: number) =>
        player(round === 0 ? index : (index + 3) % 7);
    const indicesOf = (i: number) => [i, (i + 4) % 7];

    const reportingGame = (overrides: Partial<RawGameInfo> = {}): RawGameInfo => ({
        index: 41,
        registration_ends: 1_000,
        shuffle_deadline: 2_000,
        game_date: 3_000,
        report_ends: 4_000,
        state: { type: "Reporting", value: { player_count: PLAYER_COUNT } },
        max_group_size: MAX_GROUP_SIZE,
        rounds: 2,
        pending_attendance: 7,
        airdrops_scheduled: 0,
        ...overrides,
    });

    interface FakeState {
        game?: RawGameInfo;
        empty?: Set<string>;
        identifier?: string;
        failOn?: "PlayerToIndex" | "IndexToPlayer";
    }

    function fakeChain(state: FakeState = {}) {
        const calls: Array<{ entry: string; at: string }> = [];
        const chain: CreditCandidatesChain = {
            individuality: {
                query: {
                    Game: {
                        Game: {
                            getValue: async (options) => {
                                calls.push({ entry: "Game", at: options.at });
                                return state.game;
                            },
                        },
                        PlayerToIndex: {
                            getValue: async (key, options) => {
                                options.signal?.throwIfAborted();
                                calls.push({
                                    entry: `PlayerToIndex:${keyOf(key)}`,
                                    at: options.at,
                                });
                                if (state.failOn === "PlayerToIndex")
                                    throw new Error("unreachable");
                                const i = Array.from({ length: PLAYER_COUNT }, (_, n) => n).find(
                                    (n) => keyOf(player(n)) === keyOf(key),
                                );
                                return i === undefined ? undefined : indicesOf(i);
                            },
                        },
                        IndexToPlayer: {
                            getValues: async (keys, options) => {
                                calls.push({
                                    entry: `IndexToPlayer:${keys.map(([[r, i]]) => `${r}.${i}`).join(",")}`,
                                    at: options.at,
                                });
                                if (state.failOn === "IndexToPlayer")
                                    throw new Error("unreachable");
                                return keys.map(([[round, index]]) =>
                                    state.empty?.has(`${round}.${index}`) || index >= PLAYER_COUNT
                                        ? undefined
                                        : seatedAt(round, index),
                                );
                            },
                        },
                        CommunicationIdentifiers: {
                            async getValue(account, options) {
                                calls.push({
                                    entry: `CommunicationIdentifiers:${account}`,
                                    at: options.at,
                                });
                                return state.identifier;
                            },
                        },
                    },
                },
            },
            raw: { individuality: { getFinalizedBlock: async () => BLOCK } },
        };
        return { chain, calls };
    }

    describe("numberOfGroups and groupSeats", () => {
        test("match the modulo scheme of the pallet", () => {
            expect(numberOfGroups(7, 3)).toBe(3);
            expect(members(0, 7, 3)).toEqual([0, 3, 6]);
            expect(members(4, 7, 3)).toEqual([1, 4]);
            expect(members(5, 7, 3)).toEqual([2, 5]);
        });

        test("put a small roster in one group", () => {
            expect(numberOfGroups(3, 6)).toBe(1);
            expect(members(1, 3, 6)).toEqual([0, 1, 2]);
        });

        test("keep the seats no player was shuffled into", () => {
            const small = groupSeats(1, 3, 6);
            expect(small.map((seat) => seat.index)).toEqual([0, 1, 2, 3, 4, 5]);
            expect(small.map((seat) => seat.occupied)).toEqual([
                true,
                true,
                true,
                false,
                false,
                false,
            ]);
            expect(groupSeats(4, 7, 3)).toEqual([
                { index: 1, occupied: true },
                { index: 4, occupied: true },
                { index: 7, occupied: false },
            ]);
        });

        test("have no groups and no seats without a roster", () => {
            expect(numberOfGroups(0, 6)).toBe(0);
            expect(numberOfGroups(5, 0)).toBe(0);
            expect(groupSeats(0, 0, 6)).toEqual([]);
        });
    });

    describe("readPlayerIndices", () => {
        test("returns one index per round, read at the pinned block", async () => {
            const { chain, calls } = fakeChain();
            expect(unwrapOk(await readPlayerIndices(chain, { player: player(2) }))).toEqual({
                at: AT,
                indices: [2, 6],
            });
            expect(calls).toEqual([{ entry: `PlayerToIndex:${keyOf(player(2))}`, at: BLOCK.hash }]);
        });

        test("is null for a player with no seat", async () => {
            const { chain } = fakeChain();
            const outsider = Enum("Person", `0x${"ab".repeat(32)}`);
            expect(
                unwrapOk(await readPlayerIndices(chain, { player: outsider })).indices,
            ).toBeNull();
        });

        test("a transport failure arrives on the err channel", async () => {
            const { chain } = fakeChain({ failOn: "PlayerToIndex" });
            const error = unwrapErr(await readPlayerIndices(chain, { player: player(2) }));
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });
    });

    describe("readGroupMembers", () => {
        test("resolves every occupied seat of the group, the reader included", async () => {
            const { chain, calls } = fakeChain();
            const result = unwrapOk(
                await readGroupMembers(chain, {
                    round: 1,
                    ownIndex: 4,
                    playerCount: PLAYER_COUNT,
                    maxGroupSize: MAX_GROUP_SIZE,
                }),
            );
            expect(result).toEqual({
                at: AT,
                members: [
                    { index: 1, player: seatedAt(1, 1) },
                    { index: 4, player: seatedAt(1, 4) },
                ],
            });
            expect(calls).toEqual([{ entry: "IndexToPlayer:1.1,1.4", at: BLOCK.hash }]);
        });

        test("fails when an occupied seat has no player behind it", async () => {
            const { chain } = fakeChain({ empty: new Set(["0.3"]) });
            const error = unwrapErr(
                await readGroupMembers(chain, {
                    round: 0,
                    ownIndex: 0,
                    playerCount: PLAYER_COUNT,
                    maxGroupSize: MAX_GROUP_SIZE,
                }),
            );
            expect(error.message).toMatch(/no player at a seat/);
        });

        test("fails before any round trip on an index outside the roster", async () => {
            const { chain, calls } = fakeChain();
            const error = unwrapErr(
                await readGroupMembers(chain, {
                    round: 0,
                    ownIndex: 7,
                    playerCount: PLAYER_COUNT,
                    maxGroupSize: MAX_GROUP_SIZE,
                }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(calls).toHaveLength(0);
        });
    });

    describe("readCommunicationIdentifier", () => {
        const ACCOUNT = AccountId().dec(new Uint8Array(32).fill(1));

        test("returns the 65 registered bytes", async () => {
            const { chain, calls } = fakeChain({ identifier: `0x04${"cd".repeat(64)}` });
            const { identifier } = unwrapOk(
                await readCommunicationIdentifier(chain, { account: ACCOUNT }),
            );
            expect(identifier).toHaveLength(65);
            expect(identifier?.[0]).toBe(0x04);
            expect(identifier?.[64]).toBe(0xcd);
            expect(calls).toEqual([
                { entry: `CommunicationIdentifiers:${ACCOUNT}`, at: BLOCK.hash },
            ]);
        });

        test("is null for an account that never signed up", async () => {
            const { chain } = fakeChain();
            expect(
                unwrapOk(await readCommunicationIdentifier(chain, { account: ACCOUNT })).identifier,
            ).toBeNull();
        });

        test("a value of the wrong width is a decode error", async () => {
            const { chain } = fakeChain({ identifier: `0x${"cd".repeat(64)}` });
            const error = unwrapErr(await readCommunicationIdentifier(chain, { account: ACCOUNT }));
            expect(error).toBeInstanceOf(IndividualityDecodeError);
        });
    });

    describe("readCreditCandidates", () => {
        const attestee = player(0);

        test("names one candidate per co-player per round, and hashes each", async () => {
            const { chain } = fakeChain({ game: reportingGame() });
            const expected = [
                { round: 0, attesterIndex: 3, attester: seatedAt(0, 3) },
                { round: 0, attesterIndex: 6, attester: seatedAt(0, 6) },
                { round: 1, attesterIndex: 1, attester: seatedAt(1, 1) },
            ].map((candidate) => ({
                ...candidate,
                hash: creditHash({
                    gameIndex: 41,
                    round: candidate.round,
                    attester: candidate.attester,
                    attestee,
                }),
            }));
            expect(unwrapOk(await readCreditCandidates(chain, { attestee }))).toEqual({
                at: AT,
                gameIndex: 41,
                candidates: expected,
            });
        });

        test("reads the game and the roster at the same pinned block, in one batch of seats", async () => {
            const { chain, calls } = fakeChain({ game: reportingGame() });
            await readCreditCandidates(chain, { attestee });
            expect(calls.map((call) => call.entry)).toEqual([
                "Game",
                `PlayerToIndex:${keyOf(attestee)}`,
                "IndexToPlayer:0.3,0.6,1.1",
            ]);
            expect(new Set(calls.map((call) => call.at))).toEqual(new Set([BLOCK.hash]));
        });

        test("stops at the rounds the game has, however many indices there are", async () => {
            const { chain } = fakeChain({ game: reportingGame({ rounds: 1 }) });
            const { candidates } = unwrapOk(await readCreditCandidates(chain, { attestee }));
            expect(candidates.map((candidate) => candidate.round)).toEqual([0, 0]);
        });

        test.each([
            ["no game", undefined],
            ["a game with no roster yet", reportingGame({ state: { type: "Registration" } })],
        ])("is gameIndex null with %s", async (_, game) => {
            const { chain } = fakeChain({ game });
            expect(unwrapOk(await readCreditCandidates(chain, { attestee }))).toEqual({
                at: AT,
                gameIndex: null,
                candidates: [],
            });
        });

        test("is empty for an attestee with no seat in a game that has a roster", async () => {
            const { chain } = fakeChain({ game: reportingGame() });
            const outsider = Enum("Person", `0x${"ab".repeat(32)}`);
            expect(unwrapOk(await readCreditCandidates(chain, { attestee: outsider }))).toEqual({
                at: AT,
                gameIndex: 41,
                candidates: [],
            });
        });

        test("fails when a co-player seat is empty, rather than skipping the credit", async () => {
            const { chain } = fakeChain({ game: reportingGame(), empty: new Set(["0.6"]) });
            const error = unwrapErr(await readCreditCandidates(chain, { attestee }));
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });

        test("fails on an index the player count does not cover", async () => {
            const game = reportingGame({
                state: { type: "Reporting", value: { player_count: 3 } },
            });
            const { chain } = fakeChain({ game });
            const error = unwrapErr(await readCreditCandidates(chain, { attestee: player(5) }));
            expect(error.message).toMatch(/outside the roster/);
        });
    });
}
