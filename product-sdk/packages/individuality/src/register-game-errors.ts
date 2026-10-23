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
 * The codes this package sets itself, beside the chain's own error names.
 *
 * - `Timeout`: no answer in time, from the watch or the host.
 * - `Aborted`: the caller's signal.
 * - `SigningRejected`: the player declined to sign.
 * - `HostRefused`: the host turned a call down (a grant, a proof, a key).
 * - `Network`: the connection or the block subscription dropped.
 * - `Dropped`: the transaction left the pool without a block holding it.
 * - `InvalidSignUp`: the sign-up call could not be built.
 * - `StaleAliasNeedsLiteKey`, `NoPersonhoodProver`: nothing here can make a proof the step needs.
 * - `Unknown`: anything else; the error's `message` and `cause` say what.
 */
export type GameRegistrationOwnCode =
    | "Timeout"
    | "Aborted"
    | "SigningRejected"
    | "HostRefused"
    | "Network"
    | "Dropped"
    | "InvalidSignUp"
    | "StaleAliasNeedsLiteKey"
    | "NoPersonhoodProver"
    | "Unknown";

/**
 * A failure's code: one of {@link GameRegistrationOwnCode}, or the chain's own
 * error name (`NoRegistration`, `AccountInUse`, `Custom(172)`, a blocker such as
 * `AliasBoundElsewhere`). Never free text, so it can be grouped and compared;
 * what the error said rides along as the error's `message` and `cause`.
 */
export type GameRegistrationCode = GameRegistrationOwnCode | (string & {});

/**
 * A step of the registration that failed: `stage` says which, `code` what the
 * chain or host answered, `retryable` whether running it again can help.
 */
export class GameRegistrationError extends ProductIndividualityError {
    readonly stage: GameRegistrationStep;
    readonly code: GameRegistrationCode;
    /** False when trying again cannot help: a refusal, a closed registration, a bad call. */
    readonly retryable: boolean;
    /** The sign-up's watch lost track: it may still land. */
    readonly landingUnknown: boolean;
    /** What the call did up to the failure. Set by {@link registerForGame}. */
    report?: GameRegistrationReport;

    constructor(
        stage: GameRegistrationStep,
        code: GameRegistrationCode,
        options: {
            retryable: boolean;
            landingUnknown?: boolean;
            message?: string;
            /** What the error said, kept out of `code`: it goes into the default message. */
            detail?: string;
            cause?: unknown;
        },
    ) {
        super(
            options.message ??
                `game registration failed at ${stage}: ${code}${options.detail ? ` (${options.detail})` : ""}`,
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
        code: GameRegistrationCode,
        /** For `"pinned-elsewhere"`, the account the seat is pinned to. */
        readonly account?: string,
        options: { landingUnknown?: boolean; detail?: string; cause?: unknown } = {},
    ) {
        const permanent = bindIsPermanent(refusal, code);
        super("bind", code, {
            retryable: !permanent,
            landingUnknown: options.landingUnknown,
            cause: options.cause,
            message:
                refusal === "pinned-elsewhere"
                    ? `lite bind refused: the person's free seat is on ${account ?? "another account"}`
                    : `lite bind failed: ${code}${options.detail ? ` (${options.detail})` : ""}`,
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

/**
 * For a product that retries a failed registration itself: nothing in this
 * package calls it, since `registerForGame` never retries.
 */
export function registrationRetryDelay(failures: number): number {
    const index =
        Math.min(Math.max(Math.floor(failures), 1), GAME_REGISTRATION_RETRY_MS.length) - 1;
    return GAME_REGISTRATION_RETRY_MS[index]!;
}

/**
 * An error's code: the innermost `type` of a dispatch or validity error (read
 * through PAPI's `InvalidTxError.error`), `Custom(n)` for a numbered custom
 * one, else one of this package's own codes, never the message.
 */
export function errorName(error: unknown): GameRegistrationCode {
    let node: unknown = error;
    let name: string | undefined;
    let custom: number | undefined;
    for (let depth = 0; depth < 8 && node !== null && typeof node === "object"; depth += 1) {
        const {
            type,
            value,
            error: inner,
        } = node as { type?: unknown; value?: unknown; error?: unknown };
        if (typeof type === "string") {
            name = type;
            custom = type === "Custom" && typeof value === "number" ? value : undefined;
        }
        node = value !== undefined ? value : inner;
    }
    if (name) return custom === undefined ? name : `Custom(${custom})`;
    return ownCode(error);
}

/** One of this package's codes, for an error that names no chain error. */
function ownCode(error: unknown): GameRegistrationOwnCode {
    if (error instanceof Error && error.name === "AbortError") return "Aborted";
    const text =
        error instanceof Error
            ? `${error.name} ${error.message}`
            : typeof error === "string"
              ? error
              : "";
    if (/signing was rejected|SigningRejected/i.test(text)) return "SigningRejected";
    if (/timed? ?out|timeout|no answer/i.test(text)) return "Timeout";
    if (/tracking stopped|disconnect|socket|connection|network|closed/i.test(text))
        return "Network";
    if (/HostRejected|rejected|refused|denied|not allowed|permission/i.test(text))
        return "HostRefused";
    return "Unknown";
}

/** What an error said, for a failure's message: never its code. */
export function errorDetail(error: unknown): string | undefined {
    if (error instanceof Error) return error.message || undefined;
    return typeof error === "string" && error ? error : undefined;
}

/** PAPI's words when a watch lost its blocks before the transaction's fate was known. */
export function isTrackingStopped(error: unknown): boolean {
    return error instanceof Error && /tracking stopped/i.test(error.message);
}

export function asRegistrationError(
    step: GameRegistrationStep,
    error: unknown,
): GameRegistrationError {
    if (error instanceof GameRegistrationError) return error;
    return new GameRegistrationError(step, errorName(error), {
        retryable: true,
        detail: errorDetail(error),
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
        });

        test("keeps a numbered custom error as one code", () => {
            expect(errorName({ type: "Invalid", value: { type: "Custom", value: 172 } })).toBe(
                "Custom(172)",
            );
        });

        test("never returns free text: an error with no chain name gets one of our codes", () => {
            const abort = Object.assign(new Error("stop"), { name: "AbortError" });
            expect(errorName(abort)).toBe("Aborted");
            expect(errorName(new Error("Transaction signing was rejected."))).toBe(
                "SigningRejected",
            );
            expect(errorName(new Error("ReadTimeoutError: no answer after 15 seconds"))).toBe(
                "Timeout",
            );
            expect(errorName(new Error("WebSocket closed at 0x1234…"))).toBe("Network");
            expect(errorName(new Error("Tracking stopped"))).toBe("Network");
            expect(errorName(new Error("HostRejectedError: Host rejected the request"))).toBe(
                "HostRefused",
            );
            expect(errorName(new Error("something odd at block 0xabc"))).toBe("Unknown");
            expect(errorName("plain text")).toBe("Unknown");
            expect(errorName(undefined)).toBe("Unknown");
        });

        test("a failure keeps what the error said in its message and cause, not its code", () => {
            const cause = new Error("WebSocket closed at 0x1234…");
            const failure = asRegistrationError("seat", cause);
            expect(failure.code).toBe("Network");
            expect(failure.message).toContain("WebSocket closed at 0x1234…");
            expect(failure.cause).toBe(cause);
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
