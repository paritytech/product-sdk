// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Raw PAPI storage values → domain shapes.
 *
 * Chain data is untrusted here, even though a descriptor typed it. Two traps
 * live in this file and neither is visible to the compiler:
 *
 * 1. **`Score.AbsenceGraceRatio` byte order is `(allowed_misses, window)`.** The
 *    metadata tuple is anonymous, so the order comes from the pallet's doc
 *    comment, not from the type. Getting it backwards produces plausible
 *    numbers and a wrong answer.
 * 2. **`Score.PersonhoodThreshold` is a `u8`.** PAPI maps both `u8` and `u32` to
 *    `number`, so a width mistake typechecks *and* passes tests. It is read
 *    straight through rather than decoded here, so the note lives on
 *    `PersonhoodInputs.personhoodThreshold` in `types.ts` and at the read
 *    site — but it belongs to the same class of trap as the one above.
 *
 * Unknown enum variants throw {@link IndividualityDecodeError} rather than
 * mapping to something plausible: the pallet is under active development, and a
 * variant added by a runtime upgrade must fail loudly.
 */
import { IndividualityDecodeError } from "./errors.js";
import type { AbsenceGracePolicy, PersonhoodParticipant } from "./types.js";

/** The attendance history is one byte, so the runtime caps the grace window at 8. */
const GRACE_WINDOW_MAX = 8;

/** `Score.AbsenceGraceRatio` serialized as `SizedHex<2>`: `0x` + four hex digits. */
const GRACE_RATIO_PATTERN = /^0x[0-9a-fA-F]{4}$/;

/**
 * Decode the grace policy from its strict `0x` + four-hex-digit serialization.
 *
 * Any other encoding — missing prefix, wrong length, non-hex digit — throws.
 * The value is validated rather than trusted because a `SizedHex<2>` arriving
 * malformed means the descriptor and the chain disagree.
 */
export function decodeAbsenceGracePolicy(value: string): AbsenceGracePolicy {
    if (!GRACE_RATIO_PATTERN.test(value)) {
        throw new IndividualityDecodeError("invalid absence grace policy encoding");
    }
    // Byte order is (allowed_misses, window). The metadata tuple is anonymous,
    // so the order comes from the pallet doc comment, not the type.
    const allowedMisses = Number.parseInt(value.slice(2, 4), 16);
    const window = Number.parseInt(value.slice(4, 6), 16);

    // The runtime guarantees `window <= 8` and `allowed_misses < window` for every
    // grace tier, so both checks below reject impossible chain data rather than
    // trusting it. They exist because the byte order above is unverifiable from
    // the type: were the halves ever swapped, the decode would still succeed and
    // return plausible numbers, and since the projection can return at most
    // `window`, `misses > allowedMisses` would become unreachable and `Caution`
    // would silently never fire. That turns the one trap this file cannot see
    // into a loud failure.
    if (window > GRACE_WINDOW_MAX) {
        throw new IndividualityDecodeError("absence grace window exceeds the attendance history");
    }
    // `window === 0` is the legitimate no-grace tier and carries no useful
    // allowance, so it is exempt from the ordering rule.
    if (window !== 0 && allowedMisses >= window) {
        throw new IndividualityDecodeError("absence grace policy violates allowed_misses < window");
    }

    return { allowedMisses, window };
}

/** The raw `streak` enum as PAPI decodes it: `Enum<{ Attended: u32; Absent: u32 }>`. */
export interface RawStreak {
    type: string;
    value: number;
}

/**
 * The raw `recognition` enum as PAPI decodes it:
 * `Enum<{ ExternallyRecognized; NotRecognized; Suspended: bigint; Recognized: bigint }>`.
 *
 * The payload is a revision id on two of the four variants and absent on the
 * other two. The domain does not carry it.
 */
export interface RawRecognition {
    type: string;
    value?: bigint;
}

/**
 * The raw `Score.Participants` value, narrowed to the fields the domain reads.
 *
 * The chain also sends `credit`, `cashed_out` and `has_ever_reached_personhood`.
 * All three are deliberately absent: the first two are game-economy fields with
 * no bearing on membership, and the state machine never reads the third. Extra
 * fields on the actual value are accepted — this is a structural type, not an
 * exhaustive record of the storage entry.
 */
export interface RawParticipant {
    score: number;
    streak: RawStreak;
    attendance_history: number;
    reached_personhood: boolean;
    recognition: RawRecognition;
    last_attended_game?: number | undefined;
}

/**
 * Validate a raw streak variant.
 *
 * The domain tags match the chain's variant names exactly, so this narrows
 * rather than translates.
 */
function streakTag(type: string): PersonhoodParticipant["streak"]["tag"] {
    switch (type) {
        case "Attended":
        case "Absent":
            return type;
        default:
            // A variant added by a runtime upgrade must fail loudly, never
            // silently map to a wrong streak. Fixed message: never echo chain data.
            throw new IndividualityDecodeError("unknown streak variant");
    }
}

/** Validate a raw recognition variant. Same pass-through and same policy. */
function recognitionTag(type: string): PersonhoodParticipant["recognition"] {
    switch (type) {
        case "ExternallyRecognized":
        case "NotRecognized":
        case "Suspended":
        case "Recognized":
            return type;
        default:
            throw new IndividualityDecodeError("unknown recognition variant");
    }
}

/**
 * Map a raw PAPI participant to the domain shape the derivation consumes.
 *
 * The recognition payload (a revision id) is discarded, the game-economy fields
 * are dropped, and a missing `last_attended_game` becomes `null` rather than
 * `undefined` so the domain type has one absent value, not two.
 */
export function toPersonhoodParticipant(raw: RawParticipant): PersonhoodParticipant {
    // Deliberate: unknown enum variants are detectable and validated, while the
    // numerics are descriptor-typed with no wrong value this layer could catch.
    return {
        score: raw.score,
        streak: { tag: streakTag(raw.streak.type), count: raw.streak.value },
        attendanceHistory: raw.attendance_history,
        reachedPersonhood: raw.reached_personhood,
        recognition: recognitionTag(raw.recognition.type),
        lastAttendedGame: raw.last_attended_game ?? null,
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    /** A full PAPI-shaped participant; override any field per test. */
    const rawParticipant = (overrides: Partial<RawParticipant> = {}): RawParticipant => ({
        score: 42,
        streak: { type: "Attended", value: 3 },
        attendance_history: 0b1101,
        reached_personhood: true,
        recognition: { type: "Recognized", value: 5n },
        last_attended_game: 7_777,
        ...overrides,
    });

    describe("decodeAbsenceGracePolicy", () => {
        test("decodes the serialized [allowed_misses, window] pair", () => {
            expect(decodeAbsenceGracePolicy("0x0506")).toEqual({
                allowedMisses: 5,
                window: 6,
            });
        });

        test("preserves zeroes in 0x0000", () => {
            expect(decodeAbsenceGracePolicy("0x0000")).toEqual({
                allowedMisses: 0,
                window: 0,
            });
        });

        test.each([
            ["0x", "empty value"],
            ["0x05", "one byte"],
            ["0x050", "odd length"],
            ["0x050607", "three bytes"],
            ["0x0g06", "non-hex digit"],
            ["0506", "missing 0x prefix"],
        ])("throws on %s (%s)", (value) => {
            expect(() => decodeAbsenceGracePolicy(value)).toThrow(IndividualityDecodeError);
        });

        test("rejects a window wider than the attendance history", () => {
            // Impossible chain data: the runtime caps the window at 8.
            expect(() => decodeAbsenceGracePolicy("0x01c8")).toThrow(IndividualityDecodeError);
        });

        test("rejects allowedMisses >= window, which is what a swapped byte order looks like", () => {
            // 0x0801 read in the wrong order: 8 allowed misses over a window of 1.
            // Without this check the decode succeeds and Caution never fires again.
            expect(() => decodeAbsenceGracePolicy("0x0801")).toThrow(IndividualityDecodeError);
            expect(() => decodeAbsenceGracePolicy("0x0808")).toThrow(IndividualityDecodeError);
        });

        test("still allows the no-grace tier, where the allowance is meaningless", () => {
            expect(decodeAbsenceGracePolicy("0x0000")).toEqual({ allowedMisses: 0, window: 0 });
            expect(decodeAbsenceGracePolicy("0x0500")).toEqual({ allowedMisses: 5, window: 0 });
        });

        test("the two bytes are not interchangeable", () => {
            // Guards the byte order specifically: if the halves were swapped the
            // decode would still succeed and return plausible numbers.
            expect(decodeAbsenceGracePolicy("0x0108")).toEqual({
                allowedMisses: 1,
                window: 8,
            });
        });
    });

    describe("toPersonhoodParticipant", () => {
        test("maps every field of a representative participant", () => {
            expect(toPersonhoodParticipant(rawParticipant())).toEqual({
                score: 42,
                streak: { tag: "Attended", count: 3 },
                attendanceHistory: 0b1101,
                reachedPersonhood: true,
                recognition: "Recognized",
                lastAttendedGame: 7_777,
            });
        });

        test("maps both streak variants to their PascalCase tags", () => {
            const cases: Array<[RawStreak, "Attended" | "Absent"]> = [
                [{ type: "Attended", value: 3 }, "Attended"],
                [{ type: "Absent", value: 2 }, "Absent"],
            ];
            for (const [streak, expected] of cases) {
                expect(toPersonhoodParticipant(rawParticipant({ streak }))).toEqual(
                    expect.objectContaining({
                        streak: { tag: expected, count: streak.value },
                    }),
                );
            }
        });

        test("maps all four recognition variants through unchanged", () => {
            const cases: Array<[RawRecognition, PersonhoodParticipant["recognition"]]> = [
                [{ type: "ExternallyRecognized" }, "ExternallyRecognized"],
                [{ type: "NotRecognized" }, "NotRecognized"],
                [{ type: "Suspended", value: 9n }, "Suspended"],
                [{ type: "Recognized", value: 5n }, "Recognized"],
            ];
            for (const [recognition, expected] of cases) {
                expect(toPersonhoodParticipant(rawParticipant({ recognition }))).toEqual(
                    expect.objectContaining({ recognition: expected }),
                );
            }
        });

        test("maps a missing last_attended_game to null", () => {
            expect(
                toPersonhoodParticipant(rawParticipant({ last_attended_game: undefined })),
            ).toEqual(expect.objectContaining({ lastAttendedGame: null }));
        });

        test("throws on an unknown streak variant", () => {
            const raw = rawParticipant();
            raw.streak = { type: "Maybe", value: 1 };
            expect(() => toPersonhoodParticipant(raw)).toThrow(IndividualityDecodeError);
        });

        test("throws on an unknown recognition variant", () => {
            const raw = rawParticipant();
            raw.recognition = { type: "Provisional" };
            expect(() => toPersonhoodParticipant(raw)).toThrow(IndividualityDecodeError);
        });

        test("never interpolates chain data into a decode error message", () => {
            const raw = rawParticipant();
            raw.recognition = { type: "Provisional", value: 123_456_789n };
            expect(() => toPersonhoodParticipant(raw)).toThrow(/^unknown recognition variant$/);
        });
    });
}
