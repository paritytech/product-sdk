// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Which sign-up route a player takes for the weekly game, and whether it can be
 * taken now: the one answer every product that shows or starts a sign-up has to
 * agree on.
 *
 * The chain offers several routes, and a player is shown one, chosen from their
 * situation:
 *
 * - `"returning"`: a player record already exists (`AlreadyPlaying`). The
 *   account call is free for them, with no deposit, and `withScoreParticipant`
 *   waives the fee.
 * - `"free"`: a lite person takes `sign_up_with_account_lite_invite`, `Pays::No`,
 *   valid on a zero balance. The seat is ready once the lite alias is bound to
 *   the account. A binding the ring has moved past (`StaleAlias`) is still
 *   ready, because the sign-up re-points it.
 * - `"deposit"`: nobody the chain knows, with enough funds. The account call
 *   holds the play deposit until the player leaves.
 * - `"unfunded"`: nobody the chain knows, who cannot pay the deposit and the fee.
 *   Nothing can be signed.
 *
 * The full person's route, `sign_up_with_alias`, cannot be assembled yet, so it
 * is never chosen. Game-phase blockers (`NoGameRunning`, `NotInRegistration`,
 * `AlreadyRegistered`, …) do not change the route, only whether a sign-up can
 * go out now; {@link GameSeat} carries those separately.
 *
 * Ported from jollity-next `packages/protocol/src/seat.ts`, which the game's app
 * and chat worker used before this.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";

import { ProductIndividualityError } from "./errors.js";
import type { GameChain } from "./game-read.js";
import type { ReadAt } from "./pinned.js";
import type { ScoreContextChain } from "./rings.js";
import {
    readSignUpFunds,
    signUpWithAccountTx,
    type FeeEstimable,
    type SignUpChain,
    type SignUpFunds,
    type SignUpFundsChain,
} from "./signup.js";
import { readLiteSignUpRequirement, type LiteSignUpChain } from "./signup-lite.js";
import type { LiteSignUpBlocker, LiteSignUpRequirement } from "./signup-types.js";
import type { BlockAt } from "./types.js";

/** The ways a sign-up can actually be submitted. */
export type SeatRoute = "returning" | "free" | "deposit";

/** What a product shows: a route, or why none is open to this account. */
export type SeatPath = SeatRoute | "unfunded";

/** What the chain and the host say about the player. */
export interface SeatFacts {
    /** The blockers of {@link readLiteSignUpRequirement} for the game account. */
    blockers: readonly LiteSignUpBlocker[];
    /** The account's free balance. */
    free: bigint;
    /** What the deposit route needs up front. See {@link seatRequired}. */
    required: bigint;
    /**
     * The host holds a lite-personhood key for this person, and nothing has
     * closed the lite route for the session (a bind refused for good does).
     */
    litePerson: boolean;
    /**
     * This product's own bind of the account sits in a best block. A read at
     * the finalized block trails it by a few blocks and still says
     * `AliasNotBound` about a seat that is bound.
     */
    bound?: boolean;
}

/** A route, and whether it can be pressed now. */
export interface Seat {
    path: SeatPath;
    /** False only while the free route's bind has not landed. */
    ready: boolean;
}

/** An active player record exists: the returning player's account route. */
const RETURNING = "AlreadyPlaying";
/** The lite gate the bind clears. */
const UNBOUND = "AliasNotBound";
/** The lite gates that close the lite route for this account for good. */
const LITE_CLOSED: ReadonlySet<LiteSignUpBlocker["tag"]> = new Set([
    "AliasBoundElsewhere",
    "AnotherAccountInvited",
    "AccountIsALitePerson",
    "AccountIsAStatementAccount",
    "ContextNotProductDerived",
]);
/** The game-phase blockers: no sign-up can go out until they clear. */
const NOT_OPEN: ReadonlySet<LiteSignUpBlocker["tag"]> = new Set([
    "NoGameRunning",
    "NotInRegistration",
    "RegistrationEnded",
]);

/** The fee headroom the deposit route asks for, as a multiple of the estimate. */
export const DEFAULT_FEE_HEADROOM = 2;

/**
 * What the deposit route needs up front: the deposit, plus the fee times
 * `feeHeadroom`. An estimate the runtime could not make counts as no fee.
 */
export function seatRequired(
    funds: Pick<SignUpFunds, "deposit" | "estimatedFee">,
    feeHeadroom: number = DEFAULT_FEE_HEADROOM,
): bigint {
    return funds.deposit + (funds.estimatedFee ?? 0n) * BigInt(feeHeadroom);
}

/**
 * The seat, from the facts alone. Pure, so every product decides the route the
 * same way, and a renamed blocker is a compile error in one place.
 */
export function deriveSeat(facts: SeatFacts): Seat {
    const tags = new Set(facts.blockers.map((blocker) => blocker.tag));
    let path: SeatPath;
    if (tags.has(RETURNING)) {
        path = "returning";
    } else if (facts.litePerson && ![...tags].some((tag) => LITE_CLOSED.has(tag))) {
        path = "free";
    } else {
        path = facts.free >= facts.required ? "deposit" : "unfunded";
    }
    const ready = path !== "free" || facts.bound === true || !tags.has(UNBOUND);
    return { path, ready };
}

/** {@link Seat}, with what decided it and whether a sign-up can go out now. */
export interface GameSeat extends Seat {
    /** `AlreadyRegistered`: this account is signed up for the running game. */
    registered: boolean;
    /**
     * Registration is open: none of `NoGameRunning`, `NotInRegistration`,
     * `RegistrationEnded`, judged by the chain's clock at the best block, never
     * the device's.
     */
    open: boolean;
    /** What the deposit route needs up front; see {@link seatRequired}. */
    required: bigint;
    requirement: LiteSignUpRequirement;
    funds: SignUpFunds;
}

/** `Timestamp.Now`: the chain's clock, which registration closes by. */
export interface TimestampChain {
    individuality: {
        query: {
            Timestamp: {
                /** Milliseconds. */
                Now: { getValue(options: ReadAt): Promise<bigint> };
            };
        };
    };
}

/**
 * The chain's clock at the best block, in Unix seconds: what the pallet judges
 * registration by. A phone's clock can be off by minutes, and a requirement read
 * judged by it reports `RegistrationEnded` for a game still taking sign-ups.
 *
 * Internal: shared with the registration flow.
 */
export async function chainNow(chain: TimestampChain, signal?: AbortSignal): Promise<number> {
    const ms = await chain.individuality.query.Timestamp.Now.getValue({ at: "best", signal });
    return Number(ms / 1000n);
}

/** What {@link readGameSeat} reads. */
export type GameSeatChain = GameChain &
    SignUpChain<FeeEstimable> &
    ScoreContextChain &
    LiteSignUpChain &
    SignUpFundsChain &
    TimestampChain;

/** Options for {@link readGameSeat}. */
export interface ReadGameSeatOptions {
    /** SS58. The game account, `dim2.<tld>` at `GAME_ACCOUNT_INDEX`. */
    account: string;
    /** See {@link SeatFacts.litePerson}. */
    litePerson: boolean;
    /** See {@link SeatFacts.bound}. */
    bound?: boolean;
    /** The network's DotNS TLD, such as `"paseo"`. */
    tld: string;
    /** Defaults to `"best"`, the block a sign-up is validated against. */
    at?: BlockAt;
    /** Defaults to {@link DEFAULT_FEE_HEADROOM}. */
    feeHeadroom?: number;
    signal?: AbortSignal;
}

/** Any 65 bytes estimate the same fee as the real communication identifier. */
const PLACEHOLDER_IDENTIFIER = new Uint8Array(65);

/**
 * The player's seat for the running game: the lite sign-up requirement and the
 * sign-up funds, read at `at`, folded by {@link deriveSeat}. Registration is
 * judged by the chain's clock (see {@link chainNow}).
 */
export async function readGameSeat(
    chain: GameSeatChain,
    options: ReadGameSeatOptions,
): Promise<Result<GameSeat, ProductIndividualityError>> {
    try {
        const at = options.at ?? "best";
        const { account, signal } = options;
        const now = await chainNow(chain, signal);
        const [requirement, funds] = await Promise.all([
            readLiteSignUpRequirement(chain, { account, tld: options.tld, at, now, signal }),
            readFundsWithFee(chain, account, at, signal),
        ]);
        if (!requirement.ok) return err(requirement.error);
        const required = seatRequired(funds, options.feeHeadroom);
        const seat = deriveSeat({
            blockers: requirement.value.blockers,
            free: funds.free,
            required,
            litePerson: options.litePerson,
            bound: options.bound,
        });
        const tags = requirement.value.blockers.map((blocker) => blocker.tag);
        return ok({
            ...seat,
            registered: tags.includes("AlreadyRegistered"),
            open: !tags.some((tag) => NOT_OPEN.has(tag)),
            required,
            requirement: requirement.value,
            funds,
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** The funds with the sign-up's fee, or without it when the runtime cannot estimate one. */
async function readFundsWithFee(
    chain: GameSeatChain,
    account: string,
    at: BlockAt,
    signal: AbortSignal | undefined,
): Promise<SignUpFunds> {
    const tx = signUpWithAccountTx<FeeEstimable>(chain, { identifierKey: PLACEHOLDER_IDENTIFIER });
    const withFee = await readSignUpFunds(chain, { account, tx, at, signal });
    if (withFee.ok) return withFee.value;
    const plain = await readSignUpFunds(chain, { account, at, signal });
    if (!plain.ok) throw plain.error;
    return plain.value;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const REQUIRED = 20_000_000_000n;
    const tagged = (tags: string[]) => tags.map((tag) => ({ tag }) as LiteSignUpBlocker);
    const facts = (
        tags: string[],
        free: bigint,
        extra: Partial<Pick<SeatFacts, "litePerson" | "bound" | "required">> = {},
    ): SeatFacts => ({
        blockers: tagged(tags),
        free,
        required: REQUIRED,
        litePerson: false,
        ...extra,
    });
    const person = (tags: string[], extra: Partial<Pick<SeatFacts, "bound">> = {}) =>
        facts(tags, 0n, { litePerson: true, ...extra });

    describe("deriveSeat: nobody the chain knows takes the account route", () => {
        test("is the deposit route when the account can pay, whatever the phase", () => {
            expect(deriveSeat(facts([], 30_000_000_000n)).path).toBe("deposit");
            expect(deriveSeat(facts(["NoGameRunning"], REQUIRED)).path).toBe("deposit");
            expect(
                deriveSeat(facts(["NotInRegistration", "AlreadyRegistered"], REQUIRED)).path,
            ).toBe("deposit");
        });

        test("is unfunded one planck short", () => {
            expect(deriveSeat(facts([], REQUIRED - 1n)).path).toBe("unfunded");
            expect(deriveSeat(facts([], 0n)).path).toBe("unfunded");
        });

        test("ignores the lite gates of someone who is not a lite person", () => {
            expect(deriveSeat(facts(["AliasNotBound"], 30_000_000_000n)).path).toBe("deposit");
            expect(deriveSeat(facts(["StaleAlias"], 0n)).path).toBe("unfunded");
        });
    });

    describe("deriveSeat: the returning player", () => {
        test("is the returning route, however empty the account", () => {
            expect(deriveSeat(facts(["AlreadyPlaying"], 0n)).path).toBe("returning");
            expect(
                deriveSeat(facts(["NoGameRunning", "AlreadyPlaying", "StaleAlias"], 0n)).path,
            ).toBe("returning");
        });

        test("wins over the lite route", () => {
            expect(deriveSeat(person(["AlreadyPlaying", "AliasNotBound"])).path).toBe("returning");
        });
    });

    describe("deriveSeat: a lite person takes the free route", () => {
        test("on a zero balance, bound or not, stale or not", () => {
            expect(deriveSeat(person([])).path).toBe("free");
            expect(deriveSeat(person(["NoGameRunning"])).path).toBe("free");
            expect(deriveSeat(person(["AliasNotBound"])).path).toBe("free");
            expect(deriveSeat(person(["StaleAlias"])).path).toBe("free");
        });

        test("with funds in the account too: a person never pays a deposit", () => {
            expect(deriveSeat(facts([], 30_000_000_000n, { litePerson: true })).path).toBe("free");
        });

        test("falls back to the account route once the lite route is closed", () => {
            expect(
                deriveSeat(
                    facts(["AliasNotBound", "AnotherAccountInvited"], 30_000_000_000n, {
                        litePerson: true,
                    }),
                ).path,
            ).toBe("deposit");
            expect(deriveSeat(person(["ContextNotProductDerived"])).path).toBe("unfunded");
            expect(deriveSeat(person(["AliasBoundElsewhere"])).path).toBe("unfunded");
        });
    });

    describe("deriveSeat: ready", () => {
        test("is ready on every route but a free seat with no binding", () => {
            expect(deriveSeat(facts([], REQUIRED))).toEqual({ path: "deposit", ready: true });
            expect(deriveSeat(facts([], 0n))).toEqual({ path: "unfunded", ready: true });
            expect(deriveSeat(facts(["AlreadyPlaying"], 0n))).toEqual({
                path: "returning",
                ready: true,
            });
            expect(deriveSeat(person([]))).toEqual({ path: "free", ready: true });
        });

        test("is not ready while the account has no binding", () => {
            expect(deriveSeat(person(["AliasNotBound"]))).toEqual({ path: "free", ready: false });
        });

        test("is ready once this product's own bind is in a best block", () => {
            expect(deriveSeat(person(["AliasNotBound"], { bound: true }))).toEqual({
                path: "free",
                ready: true,
            });
        });

        test("is ready on a stale binding: the sign-up re-points it", () => {
            expect(deriveSeat(person(["StaleAlias"]))).toEqual({ path: "free", ready: true });
        });
    });

    describe("chainNow", () => {
        test("reads the best block's timestamp and returns whole seconds", async () => {
            const seen: string[] = [];
            const chain = {
                individuality: {
                    query: {
                        Timestamp: {
                            Now: {
                                getValue: async (options: ReadAt) => {
                                    seen.push(options.at);
                                    return 1_792_159_444_713n;
                                },
                            },
                        },
                    },
                },
            };
            expect(await chainNow(chain)).toBe(1_792_159_444);
            expect(seen).toEqual(["best"]);
        });
    });

    describe("seatRequired", () => {
        test("is the deposit plus twice the fee by default", () => {
            expect(seatRequired({ deposit: 100n, estimatedFee: 7n })).toBe(114n);
        });

        test("counts a fee the runtime could not estimate as none", () => {
            expect(seatRequired({ deposit: 100n, estimatedFee: null })).toBe(100n);
        });

        test("takes another headroom", () => {
            expect(seatRequired({ deposit: 100n, estimatedFee: 7n }, 3)).toBe(121n);
        });
    });
}
