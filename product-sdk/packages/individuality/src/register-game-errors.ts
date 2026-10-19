// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * How game registration fails: the error classes, which chain answers a retry
 * can change, the retry ladder, and the name of a chain error.
 */
import { ProductIndividualityError } from "./errors.js";
import type {
    GameRegistrationReport,
    GameRegistrationStep,
    GameSeatBindRefusal,
} from "./register-game-types.js";

/**
 * A step of the registration that failed: `stage` says which, `code` what the
 * chain or host answered, `retryable` whether running it again can help.
 */
export class GameRegistrationError extends ProductIndividualityError {
    readonly stage: GameRegistrationStep;
    readonly code: string;
    /** False when trying again cannot help: a refusal, a closed registration, a bad call. */
    readonly retryable: boolean;
    /** The sign-up's watch lost track: it may still land. */
    readonly landingUnknown: boolean;
    /** What the call did up to the failure. Set by {@link registerForGame}. */
    report?: GameRegistrationReport;

    constructor(
        stage: GameRegistrationStep,
        code: string,
        options: {
            retryable: boolean;
            landingUnknown?: boolean;
            message?: string;
            cause?: unknown;
        },
    ) {
        super(
            options.message ?? `game registration failed at ${stage}: ${code}`,
            options.cause === undefined ? undefined : { cause: options.cause },
        );
        this.name = "GameRegistrationError";
        this.stage = stage;
        this.code = code;
        this.retryable = options.retryable;
        this.landingUnknown = options.landingUnknown === true;
    }
}

/** The chain's refusals of `PeopleLite.set_alias_account` that a retry will not change. */
const PERMANENT_BIND_CODES: ReadonlySet<string> = new Set([
    "AccountInUse",
    "InvalidAliasContext",
    "AlreadyRegistered",
]);

function bindIsPermanent(refusal: GameSeatBindRefusal, code: string): boolean {
    return refusal !== "rejected" || PERMANENT_BIND_CODES.has(code);
}

/** A bind that did not land. `permanent` closes the lite route for this account. */
export class GameSeatBindError extends GameRegistrationError {
    /** True when trying again cannot change the answer. The opposite of `retryable`. */
    readonly permanent: boolean;

    constructor(
        readonly refusal: GameSeatBindRefusal,
        code: string,
        /** For `"pinned-elsewhere"`, the account the seat is pinned to. */
        readonly account?: string,
        options: { landingUnknown?: boolean } = {},
    ) {
        const permanent = bindIsPermanent(refusal, code);
        super("bind", code, {
            retryable: !permanent,
            landingUnknown: options.landingUnknown,
            message:
                refusal === "pinned-elsewhere"
                    ? `lite bind refused: the person's free seat is on ${account ?? "another account"}`
                    : `lite bind failed: ${code}`,
        });
        this.name = "GameSeatBindError";
        this.permanent = permanent;
    }
}

/** The sign-up refusals that a retry will not change. */
export const NOT_RETRYABLE_SIGN_UP: ReadonlySet<string> = new Set([
    "NoGame",
    "NoRegistration",
    "InvalidAirdropVrfCount",
    "InvalidAirdropVrfVariant",
    "InvalidAirdropVrfVariantForAccount",
    "InvalidAirdropVrfVariantForRecognition",
    "AnotherAccountInvited",
    "StatementAccountAlreadyInUse",
    "Payment",
    "InsufficientBalance",
    "SigningRejected",
    "InvalidSignUp",
]);

/**
 * How long to wait before the next try, after `failures` failures in a row:
 * 5 s, 15 s, 45 s, 2 min, then 5 min. Check `retryable` first.
 */
export const GAME_REGISTRATION_RETRY_MS: readonly number[] = [
    5_000, 15_000, 45_000, 120_000, 300_000,
];

export function registrationRetryDelay(failures: number): number {
    const index =
        Math.min(Math.max(Math.floor(failures), 1), GAME_REGISTRATION_RETRY_MS.length) - 1;
    return GAME_REGISTRATION_RETRY_MS[index]!;
}

/**
 * The name of a chain error: the innermost `type` of a dispatch or validity
 * error (read through PAPI's `InvalidTxError.error`), else the message.
 */
export function errorName(error: unknown): string {
    let node: unknown = error;
    let name: string | undefined;
    for (let depth = 0; depth < 8 && node !== null && typeof node === "object"; depth += 1) {
        const {
            type,
            value,
            error: inner,
        } = node as { type?: unknown; value?: unknown; error?: unknown };
        if (typeof type === "string") name = type;
        node = value !== undefined ? value : inner;
    }
    if (name) return name;
    if (error instanceof Error && error.message) return error.message;
    return typeof error === "string" && error ? error : "DispatchError";
}

export function asRegistrationError(
    step: GameRegistrationStep,
    error: unknown,
): GameRegistrationError {
    if (error instanceof GameRegistrationError) return error;
    const aborted = error instanceof Error && error.name === "AbortError";
    return new GameRegistrationError(step, aborted ? "Aborted" : errorName(error), {
        retryable: true,
        cause: error,
    });
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    describe("registrationRetryDelay", () => {
        test("climbs the ladder and stays on its last rung", () => {
            expect([1, 2, 3, 4, 5, 9].map(registrationRetryDelay)).toEqual([
                5_000, 15_000, 45_000, 120_000, 300_000, 300_000,
            ]);
            expect(registrationRetryDelay(0)).toBe(5_000);
        });
    });

    describe("errorName", () => {
        test("finds the innermost name of a nested dispatch error", () => {
            expect(
                errorName({
                    type: "Module",
                    value: { type: "Game", value: { type: "NoRegistration" } },
                }),
            ).toBe("NoRegistration");
            expect(errorName(new Error("socket closed"))).toBe("socket closed");
        });

        test("reads PAPI's InvalidTxError through its error, not its JSON message", () => {
            const validity = { type: "Invalid", value: { type: "BadProof" } };
            const invalid = Object.assign(new Error(JSON.stringify(validity, null, 2)), {
                name: "InvalidTxError",
                error: validity,
            });
            expect(errorName(invalid)).toBe("BadProof");
        });
    });
}
