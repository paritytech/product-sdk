// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The pure personhood derivation: chain facts in, one {@link PersonhoodState}
 * out.
 *
 * This module performs no I/O and holds no chain types. It is the artifact
 * issue #291 consumes, which is why it is exported separately from the read and
 * must never import from `read.ts`.
 *
 * A participant record always beats Lite personhood, external recognition is
 * permanent, and `Caution` is a *projection* of the next absence rather than a
 * count of past ones. See the package skill for the plain-language version.
 */
import type { PersonhoodInputs, PersonhoodParticipant, PersonhoodState } from "./types.js";

/** Attendance history is one byte, so a window wider than 8 games is capped. */
const HISTORY_BITS = 8;

/** Count set bits without allocating (Kernighan). */
function countSetBits(value: number): number {
    let count = 0;
    let remaining = value;
    while (remaining !== 0) {
        remaining &= remaining - 1;
        count += 1;
    }
    return count;
}

/**
 * Misses a next-game absence would leave inside the window, mirroring the
 * runtime: `store_attendance(false)` (shift left, so bit 0 becomes the miss)
 * followed by `misses_in_window(window)`.
 *
 * The window is clamped to the one-byte history width; a JS number is not a
 * `u8`, so the shift is masked back down explicitly.
 */
function projectedMisses(history: number, window: number): number {
    const next = (history << 1) & 0xff;
    const clamped = window >= HISTORY_BITS ? HISTORY_BITS : Math.max(window, 0);
    const mask = (1 << clamped) - 1;
    return clamped - countSetBits(next & mask);
}

/**
 * Derive a person's membership standing from one pinned snapshot.
 *
 * Never throws: an inconsistent record degrades to `Suspended` rather than
 * failing the caller's render.
 */
export function derivePersonhoodState(snapshot: PersonhoodInputs): PersonhoodState {
    const { participant } = snapshot;

    // A participant record always wins over Lite personhood.
    if (participant === null) {
        return snapshot.isLitePerson ? { tag: "Lite" } : { tag: "NotEnrolled" };
    }

    const activeWeeks = participant.streak.tag === "Attended" ? participant.streak.count : 0;

    switch (participant.recognition) {
        case "ExternallyRecognized":
            // External recognition is permanent: personhood is never lost, so this
            // stays a plain member even when the personhood flag is unset. Testing
            // the flag before the recognition variant gets this wrong.
            return { tag: "Member", activeWeeks, lastAttendedGame: participant.lastAttendedGame };

        case "Suspended":
            return { tag: "Suspended" };

        case "Recognized": {
            if (!participant.reachedPersonhood) {
                // Fail-safe: recognized without personhood is inconsistent state.
                return { tag: "Suspended" };
            }
            const misses = projectedMisses(participant.attendanceHistory, snapshot.policy.window);
            // Window 0 means no grace (the runtime suspends immediately): the next
            // absence suspends regardless of the counted misses.
            if (snapshot.policy.window === 0 || misses > snapshot.policy.allowedMisses) {
                return {
                    tag: "Caution",
                    misses,
                    allowedMisses: snapshot.policy.allowedMisses,
                    window: snapshot.policy.window,
                    lastAttendedGame: participant.lastAttendedGame,
                };
            }
            return { tag: "Member", activeWeeks, lastAttendedGame: participant.lastAttendedGame };
        }

        case "NotRecognized":
            // `score` is reported, not compared: the chain owns `reachedPersonhood`,
            // and re-deriving it from the threshold here would drift from it.
            return participant.reachedPersonhood
                ? { tag: "MembershipReady" }
                : {
                      tag: "Candidate",
                      score: participant.score,
                      personhoodThreshold: snapshot.personhoodThreshold,
                  };
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    /** Recognized, at personhood, fully attended for the last 8 games. */
    const participant = (
        overrides: Partial<PersonhoodParticipant> = {},
    ): PersonhoodParticipant => ({
        score: 7,
        streak: { tag: "Attended", count: 4 },
        attendanceHistory: 0b11111111,
        reachedPersonhood: true,
        recognition: "Recognized",
        lastAttendedGame: 42,
        ...overrides,
    });

    /** Snapshot around a recognized member; override per test. */
    const snapshot = (overrides: Partial<PersonhoodInputs> = {}): PersonhoodInputs => ({
        isLitePerson: false,
        participant: participant(),
        personhoodThreshold: 5,
        policy: { allowedMisses: 1, window: 8 },
        ...overrides,
    });

    describe("derivePersonhoodState", () => {
        test("is NotEnrolled without a participant or Lite personhood", () => {
            expect(
                derivePersonhoodState(snapshot({ participant: null, isLitePerson: false })),
            ).toEqual({ tag: "NotEnrolled" });
        });

        test("is Lite for a Lite person who has no participant record", () => {
            expect(
                derivePersonhoodState(snapshot({ participant: null, isLitePerson: true })),
            ).toEqual({ tag: "Lite" });
        });

        test("prefers the participant over Lite personhood", () => {
            expect(
                derivePersonhoodState(
                    snapshot({
                        isLitePerson: true,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 7, personhoodThreshold: 5 });
        });

        test("reports Candidate with the participant's score against the snapshot threshold", () => {
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 5,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 3,
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 3, personhoodThreshold: 5 });
        });

        test("is MembershipReady once personhood is reached before recognition", () => {
            expect(
                derivePersonhoodState(
                    snapshot({
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: true,
                        }),
                    }),
                ),
            ).toEqual({ tag: "MembershipReady" });
        });

        test("keeps a recognized person a Member while the window is clean", () => {
            expect(derivePersonhoodState(snapshot())).toEqual({
                tag: "Member",
                activeWeeks: 4,
                lastAttendedGame: 42,
            });
        });

        test("reports the attended streak as active weeks and zero for an absent streak", () => {
            expect(
                derivePersonhoodState(
                    snapshot({
                        participant: participant({ streak: { tag: "Attended", count: 2 } }),
                    }),
                ),
            ).toEqual({ tag: "Member", activeWeeks: 2, lastAttendedGame: 42 });
            expect(
                derivePersonhoodState(
                    snapshot({
                        participant: participant({ streak: { tag: "Absent", count: 3 } }),
                    }),
                ),
            ).toEqual({ tag: "Member", activeWeeks: 0, lastAttendedGame: 42 });
        });

        test("never cautions an externally recognized member", () => {
            // 0b11001111: two misses inside the window, so a Recognized member here
            // would be cautioned — external recognition stays a plain member.
            const risky = participant({
                recognition: "ExternallyRecognized",
                attendanceHistory: 0b11001111,
            });
            expect(derivePersonhoodState(snapshot({ participant: risky }))).toEqual({
                tag: "Member",
                activeWeeks: 4,
                lastAttendedGame: 42,
            });
            // External recognition holds even when the personhood flag is unset.
            expect(
                derivePersonhoodState(
                    snapshot({ participant: { ...risky, reachedPersonhood: false } }),
                ),
            ).toEqual({ tag: "Member", activeWeeks: 4, lastAttendedGame: 42 });
        });

        test("cautions exactly when the next absence crosses the grace policy", () => {
            // 0b11111110: one live miss at the newest bit; a new absence shifts it to
            // bit 1 and lands a second miss, so `misses` is the projected 2 (> 1).
            expect(
                derivePersonhoodState(
                    snapshot({ participant: participant({ attendanceHistory: 0b11111110 }) }),
                ),
            ).toEqual({
                tag: "Caution",
                misses: 2,
                allowedMisses: 1,
                window: 8,
                lastAttendedGame: 42,
            });
            // Zero allowed misses: even a clean window crosses on the next absence.
            expect(
                derivePersonhoodState(snapshot({ policy: { allowedMisses: 0, window: 8 } })),
            ).toEqual({
                tag: "Caution",
                misses: 1,
                allowedMisses: 0,
                window: 8,
                lastAttendedGame: 42,
            });
            // A clean window with one allowed miss stays a member: 1 is not > 1.
            expect(derivePersonhoodState(snapshot())).toEqual({
                tag: "Member",
                activeWeeks: 4,
                lastAttendedGame: 42,
            });
        });

        test("stays a Member when an old miss shifts out of the window", () => {
            // 0b01111111: the only miss is bit 7 (oldest); shifting in a new absence
            // evicts it, so the projected window still holds exactly one miss.
            expect(
                derivePersonhoodState(
                    snapshot({ participant: participant({ attendanceHistory: 0b01111111 }) }),
                ),
            ).toEqual({ tag: "Member", activeWeeks: 4, lastAttendedGame: 42 });
        });

        test("suspends a Suspended participant even with personhood reached", () => {
            expect(
                derivePersonhoodState(
                    snapshot({ participant: participant({ recognition: "Suspended" }) }),
                ),
            ).toEqual({ tag: "Suspended" });
        });

        test("fail-safes to Suspended when recognized without personhood", () => {
            expect(
                derivePersonhoodState(
                    snapshot({
                        participant: participant({
                            recognition: "Recognized",
                            reachedPersonhood: false,
                        }),
                    }),
                ),
            ).toEqual({ tag: "Suspended" });
        });

        // --- Added here, not present in the humanity-spa suite -----------------

        test("window 0 cautions regardless of the projected miss count", () => {
            // No grace at all: the next absence suspends whatever the window holds.
            // The projection over a zero-width window is 0, which is *below*
            // allowedMisses — so reaching Caution here proves the short-circuit
            // runs before the comparison.
            expect(
                derivePersonhoodState(snapshot({ policy: { allowedMisses: 1, window: 0 } })),
            ).toEqual({
                tag: "Caution",
                misses: 0,
                allowedMisses: 1,
                window: 0,
                lastAttendedGame: 42,
            });
        });

        test("score exactly at the threshold is still Candidate", () => {
            // The chain owns `reachedPersonhood`; the derivation must not infer
            // personhood from `score >= personhoodThreshold`.
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 5,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 5,
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 5, personhoodThreshold: 5 });
        });

        test("handles the attendance-history byte boundaries", () => {
            // 0xff, perfect attendance: the shift leaves exactly one projected
            // miss, which is not > 1, so the member holds.
            expect(
                derivePersonhoodState(
                    snapshot({ participant: participant({ attendanceHistory: 0xff }) }),
                ),
            ).toEqual({ tag: "Member", activeWeeks: 4, lastAttendedGame: 42 });
            // 0x00, never attended: the whole window is misses.
            expect(
                derivePersonhoodState(
                    snapshot({ participant: participant({ attendanceHistory: 0x00 }) }),
                ),
            ).toEqual({
                tag: "Caution",
                misses: 8,
                allowedMisses: 1,
                window: 8,
                lastAttendedGame: 42,
            });
        });
    });
}
