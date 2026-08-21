// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Prize-draw event ids, derived offline. No storage entry lists them, so this is
 * the entry point to every read in `airdrop-read.ts`.
 *
 * ```
 * Game:            base(27) ‖ airdrop_index(u8) ‖ game_index(u32 BE)
 * PeopleAirdrops:  base(24) ‖ draw_index(u64 BE)
 * ```
 *
 * `Game`'s base is a runtime constant; `PeopleAirdrops`' never reaches metadata, so
 * it is hardcoded and the pinned vectors are its only guard.
 *
 * **This layout is paseo's.** Devnet's base is 28 bytes — one draw per game, so no
 * airdrop-index byte. `SizedHex<N>` erases `N`, so nothing typechecks that: the
 * length check in {@link gameAirdropEventId} is the whole guard.
 */
import { ProductIndividualityError } from "./errors.js";

/**
 * `Game::airdrop_event_id_base()` — 27 bytes, the ten trailing spaces included as
 * part of the value. The pinned expectation; production reads the chain's copy.
 */
export const GAME_AIRDROP_EVENT_ID_BASE = "pop:game:airdrop:          ";

/**
 * `indiv_pallet_people_airdrops::EVENT_ID_BASE` — 24 bytes, four trailing spaces
 * included. Hardcoded because it never reaches metadata, unlike `Game`'s; if it
 * ever gains an `extra_constants` entry, read that and delete this.
 */
export const PEOPLE_AIRDROPS_EVENT_ID_BASE = "pop:people-airdrops:    ";

/** `Game`'s `MAX_GAME_AIRDROPS`: a game schedules at most this many draws. */
export const MAX_GAME_AIRDROPS = 16;

/** Every event id is 32 bytes, both layouts. */
const EVENT_ID_BYTES = 32;

const GAME_BASE_BYTES = 27;
const PEOPLE_AIRDROPS_BASE_BYTES = 24;

const U8_MAX = 0xff;
const U32_MAX = 0xff_ff_ff_ff;
const U64_MAX = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/** `0x`-prefixed lower-case hex, the form every PAPI storage key here takes. */
function toEventId(bytes: Uint8Array): string {
    let hex = "";
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, "0");
    }
    return `0x${hex}`;
}

/**
 * A base as bytes, from `0x` hex (the chain constant) or ASCII (the pinned ones).
 * A wrong length is a chain-versus-client disagreement, so it throws rather than
 * pad or truncate into something plausible.
 */
function baseBytes(base: string | Uint8Array, expectedLength: number): Uint8Array {
    const bytes = typeof base === "string" ? decodeBase(base) : base;
    if (bytes.length !== expectedLength) {
        throw new ProductIndividualityError("airdrop event id base has the wrong length");
    }
    return bytes;
}

/** Hex if it is `0x`-prefixed, UTF-8 otherwise. */
function decodeBase(base: string): Uint8Array {
    if (!base.startsWith("0x")) {
        return new TextEncoder().encode(base);
    }
    const digits = base.slice(2);
    if (digits.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(digits)) {
        throw new ProductIndividualityError("airdrop event id base is not valid hex");
    }
    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function checkIndex(value: number, max: number, what: string): number {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new ProductIndividualityError(`airdrop ${what} is out of range`);
    }
    return value;
}

/**
 * Mirrors `Game::airdrop_event_id`, a plain `impl` method, so only its base reaches
 * metadata and the pinned vectors below keep this honest.
 *
 * @param options.base - pass the chain constant, not
 *   {@link GAME_AIRDROP_EVENT_ID_BASE}, so a base change cannot desync this.
 * @throws ProductIndividualityError on a malformed base, or an index wider than its
 *   chain type (`u32` game, `u8` airdrop).
 */
export function gameAirdropEventId(options: {
    base: string | Uint8Array;
    gameIndex: number;
    airdropIndex: number;
}): string {
    const base = baseBytes(options.base, GAME_BASE_BYTES);
    // A u8 on chain. Not capped at MAX_GAME_AIRDROPS: `claim_airdrop` takes the
    // full width, and capping here would make a legitimate id underivable.
    const airdropIndex = checkIndex(options.airdropIndex, U8_MAX, "index");
    const gameIndex = checkIndex(options.gameIndex, U32_MAX, "game index");

    const id = new Uint8Array(EVENT_ID_BYTES);
    id.set(base, 0);
    id[GAME_BASE_BYTES] = airdropIndex;
    // u32, big-endian. `>>>` keeps the shift unsigned; a signed `>>` would be
    // wrong for indices above 2^31.
    id[28] = (gameIndex >>> 24) & U8_MAX;
    id[29] = (gameIndex >>> 16) & U8_MAX;
    id[30] = (gameIndex >>> 8) & U8_MAX;
    id[31] = gameIndex & U8_MAX;
    return toEventId(id);
}

/**
 * Derive a `PeopleAirdrops` draw's event id, mirroring
 * `PeopleAirdrops::draw_event_id`. The `u64` index takes a `bigint` or a
 * safe-integer `number`: anything above `MAX_SAFE_INTEGER` would round before
 * reaching the encoder and address a draw nobody scheduled, so it throws.
 */
export function peopleAirdropsEventId(drawIndex: number | bigint): string {
    let index: bigint;
    if (typeof drawIndex === "bigint") {
        index = drawIndex;
    } else {
        if (!Number.isSafeInteger(drawIndex)) {
            throw new ProductIndividualityError("airdrop draw index is out of range");
        }
        index = BigInt(drawIndex);
    }
    if (index < 0n || index > U64_MAX) {
        throw new ProductIndividualityError("airdrop draw index is out of range");
    }

    const base = baseBytes(PEOPLE_AIRDROPS_EVENT_ID_BASE, PEOPLE_AIRDROPS_BASE_BYTES);
    const id = new Uint8Array(EVENT_ID_BYTES);
    id.set(base, 0);
    // u64, big-endian: fill the last eight bytes from the low end up.
    for (let i = 0; i < 8; i++) {
        id[31 - i] = Number((index >> BigInt(i * 8)) & 0xffn);
    }
    return toEventId(id);
}

/**
 * Every draw id of one game, in airdrop-index order. `airdropsScheduled` only
 * exists while that game is current, so a past game's count must have been
 * captured — probing cannot tell a cleaned-up draw from one never scheduled.
 */
export function gameAirdropEventIds(options: {
    base: string | Uint8Array;
    gameIndex: number;
    airdropsScheduled: number;
}): string[] {
    const count = checkIndex(options.airdropsScheduled, MAX_GAME_AIRDROPS, "draw count");
    return Array.from({ length: count }, (_, airdropIndex) =>
        gameAirdropEventId({
            base: options.base,
            gameIndex: options.gameIndex,
            airdropIndex,
        }),
    );
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    /**
     * Hex of an ASCII string, computed here rather than with the module's own
     * helper: a vector that shares its encoder with the code under test pins
     * nothing.
     */
    const asciiHex = (text: string): string =>
        [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

    describe("the pinned bases", () => {
        test("Game's base is 27 bytes with its padding intact", () => {
            expect(new TextEncoder().encode(GAME_AIRDROP_EVENT_ID_BASE)).toHaveLength(27);
            expect(GAME_AIRDROP_EVENT_ID_BASE).toBe("pop:game:airdrop:          ");
        });

        test("PeopleAirdrops' base is 24 bytes with its padding intact", () => {
            expect(new TextEncoder().encode(PEOPLE_AIRDROPS_EVENT_ID_BASE)).toHaveLength(24);
            expect(PEOPLE_AIRDROPS_EVENT_ID_BASE).toBe("pop:people-airdrops:    ");
        });
    });

    describe("gameAirdropEventId", () => {
        test("lays out base ++ airdrop_index ++ game_index big-endian", () => {
            expect(
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 1,
                    airdropIndex: 0,
                }),
            ).toBe(`0x${asciiHex("pop:game:airdrop:          ")}0000000001`);
        });

        test("pins a multi-byte game index and a non-zero airdrop index", () => {
            expect(
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 0x01_02_03_04,
                    airdropIndex: 0x0f,
                }),
            ).toBe(`0x${asciiHex("pop:game:airdrop:          ")}0f01020304`);
        });

        test("keeps a game index above 2^31 unsigned", () => {
            // A signed shift would produce ff… here. This is the case a `>>`
            // typo passes every other test with.
            expect(
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 0x80_00_00_01,
                    airdropIndex: 0,
                }),
            ).toBe(`0x${asciiHex("pop:game:airdrop:          ")}0080000001`);
        });

        test("accepts the base as chain hex, identically to the ASCII literal", () => {
            const fromHex = gameAirdropEventId({
                base: `0x${asciiHex(GAME_AIRDROP_EVENT_ID_BASE)}`,
                gameIndex: 7,
                airdropIndex: 2,
            });
            const fromAscii = gameAirdropEventId({
                base: GAME_AIRDROP_EVENT_ID_BASE,
                gameIndex: 7,
                airdropIndex: 2,
            });
            expect(fromHex).toBe(fromAscii);
        });

        test("accepts the base as bytes", () => {
            expect(
                gameAirdropEventId({
                    base: new TextEncoder().encode(GAME_AIRDROP_EVENT_ID_BASE),
                    gameIndex: 7,
                    airdropIndex: 2,
                }),
            ).toBe(
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 7,
                    airdropIndex: 2,
                }),
            );
        });

        test("is always 32 bytes", () => {
            const id = gameAirdropEventId({
                base: GAME_AIRDROP_EVENT_ID_BASE,
                gameIndex: 0,
                airdropIndex: 0,
            });
            expect(id).toHaveLength(2 + 64);
        });

        test("distinct (game, airdrop) pairs give distinct ids", () => {
            const id = (gameIndex: number, airdropIndex: number) =>
                gameAirdropEventId({ base: GAME_AIRDROP_EVENT_ID_BASE, gameIndex, airdropIndex });
            expect(new Set([id(1, 0), id(0, 1), id(1, 1), id(0, 0)]).size).toBe(4);
        });

        test.each([
            [26, "one byte short"],
            [28, "one byte long"],
        ])("rejects a %i-byte base (%s)", (length) => {
            expect(() =>
                gameAirdropEventId({
                    base: new Uint8Array(length),
                    gameIndex: 0,
                    airdropIndex: 0,
                }),
            ).toThrow(ProductIndividualityError);
        });

        test("rejects a malformed hex base", () => {
            expect(() =>
                gameAirdropEventId({ base: "0xzz", gameIndex: 0, airdropIndex: 0 }),
            ).toThrow(ProductIndividualityError);
        });

        test.each([
            [-1, 0, "negative game index"],
            [1.5, 0, "fractional game index"],
            [U32_MAX + 1, 0, "game index above u32"],
            [0, -1, "negative airdrop index"],
            [0, 256, "airdrop index above u8"],
            [Number.NaN, 0, "NaN"],
        ])("rejects gameIndex %s / airdropIndex %s (%s)", (gameIndex, airdropIndex) => {
            expect(() =>
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex,
                    airdropIndex,
                }),
            ).toThrow(ProductIndividualityError);
        });

        test("allows an airdrop index above MAX_GAME_AIRDROPS", () => {
            // `claim_airdrop` takes a full u8, so capping the derivation at the
            // scheduling limit would make a legitimate id underivable.
            expect(() =>
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 0,
                    airdropIndex: MAX_GAME_AIRDROPS + 1,
                }),
            ).not.toThrow();
        });
    });

    describe("peopleAirdropsEventId", () => {
        test("lays out base ++ draw_index as a big-endian u64", () => {
            expect(peopleAirdropsEventId(0)).toBe(
                `0x${asciiHex("pop:people-airdrops:    ")}0000000000000000`,
            );
            expect(peopleAirdropsEventId(1)).toBe(
                `0x${asciiHex("pop:people-airdrops:    ")}0000000000000001`,
            );
        });

        test("pins a draw index using all eight bytes", () => {
            expect(peopleAirdropsEventId(0x01_02_03_04_05_06_07_08n)).toBe(
                `0x${asciiHex("pop:people-airdrops:    ")}0102030405060708`,
            );
        });

        test("pins the u64 maximum", () => {
            expect(peopleAirdropsEventId(U64_MAX)).toBe(
                `0x${asciiHex("pop:people-airdrops:    ")}ffffffffffffffff`,
            );
        });

        test("a number and the same bigint agree", () => {
            expect(peopleAirdropsEventId(4_294_967_296)).toBe(
                peopleAirdropsEventId(4_294_967_296n),
            );
        });

        test("is always 32 bytes", () => {
            expect(peopleAirdropsEventId(0)).toHaveLength(2 + 64);
        });

        test("never collides with a Game id", () => {
            // Different bases, so this is really a check that the bases differ
            // in their first 24 bytes — which is what makes the two schedulers'
            // id spaces disjoint.
            expect(peopleAirdropsEventId(0)).not.toBe(
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 0,
                    airdropIndex: 0,
                }),
            );
        });

        test.each([
            [-1n, "negative"],
            [U64_MAX + 1n, "above u64"],
        ])("rejects %s (%s)", (drawIndex) => {
            expect(() => peopleAirdropsEventId(drawIndex)).toThrow(ProductIndividualityError);
        });

        test.each([
            [-1, "negative"],
            [1.5, "fractional"],
            [Number.NaN, "NaN"],
            [Number.MAX_SAFE_INTEGER + 1, "beyond safe-integer range"],
        ])("rejects the number %s (%s)", (drawIndex) => {
            expect(() => peopleAirdropsEventId(drawIndex)).toThrow(ProductIndividualityError);
        });
    });

    describe("gameAirdropEventIds", () => {
        test("returns one id per scheduled draw, in index order", () => {
            const ids = gameAirdropEventIds({
                base: GAME_AIRDROP_EVENT_ID_BASE,
                gameIndex: 3,
                airdropsScheduled: 3,
            });
            expect(ids).toEqual([
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 3,
                    airdropIndex: 0,
                }),
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 3,
                    airdropIndex: 1,
                }),
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 3,
                    airdropIndex: 2,
                }),
            ]);
        });

        test("a game with no draws yields no ids", () => {
            expect(
                gameAirdropEventIds({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 3,
                    airdropsScheduled: 0,
                }),
            ).toEqual([]);
        });

        test("rejects a count above MAX_GAME_AIRDROPS", () => {
            expect(() =>
                gameAirdropEventIds({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 3,
                    airdropsScheduled: MAX_GAME_AIRDROPS + 1,
                }),
            ).toThrow(ProductIndividualityError);
        });
    });
}
