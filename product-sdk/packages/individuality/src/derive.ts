// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The pure personhood derivation: chain facts in, one {@link PersonhoodState}
 * out.
 *
 * This module performs no I/O and holds no chain types. It is exported
 * separately from the read so callers can derive against a snapshot they
 * already hold, with no chain client, and for that reason must never import
 * from `read.ts`.
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
 * Misses the window currently holds: the games inside it that were absences.
 *
 * Mirrors the runtime's `misses_in_window(window)` on the history exactly as
 * stored. The window is clamped to the one-byte history width, so a wider
 * policy counts eight games and no more.
 */
export function missesInWindow(history: number, window: number): number {
    const clamped = window >= HISTORY_BITS ? HISTORY_BITS : Math.max(window, 0);
    const mask = (1 << clamped) - 1;
    return clamped - countSetBits(history & mask);
}

/**
 * Misses a next-game absence would leave inside the window, mirroring the
 * runtime: `store_attendance(false)` (shift left, so bit 0 becomes the miss)
 * followed by `misses_in_window(window)`.
 *
 * A JS number is not a `u8`, so the shift is masked back down explicitly before
 * the window is counted.
 */
function projectedMisses(history: number, window: number): number {
    return missesInWindow((history << 1) & 0xff, window);
}
/**
 * Project candidate progress using the runtime's streak-weighted scoring.
 *
 * An absence resets the next attended streak to one. Otherwise the next game
 * increments the current attended streak before adding it to the score.
 */
function candidateGamesRemaining(
    participant: PersonhoodParticipant,
    personhoodThreshold: number,
): number {
    let score = participant.score;
    let streak = participant.streak.tag === "Attended" ? participant.streak.count : 0;
    let games = 0;
    while (score < personhoodThreshold) {
        streak += 1;
        score += streak;
        games += 1;
    }
    return games;
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
                      gamesRemaining: candidateGamesRemaining(
                          participant,
                          snapshot.personhoodThreshold,
                      ),
                  };

        default:
            // A public export, documented as usable against a snapshot you
            // already hold, so inputs need not have met the decoder. A
            // never-throwing module must not fall off the end and return
            // `undefined`. `satisfies never` keeps the exhaustiveness check a
            // bare `default` would remove.
            participant.recognition satisfies never;
            return { tag: "Suspended" };
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

    describe("missesInWindow", () => {
        // Mirrors the runtime's `store_attendance`, so the vectors below can be
        // written the way the pallet writes them: from a default history
        // forward, one game at a time.
        const store = (history: number, attended: boolean) =>
            ((history << 1) | (attended ? 1 : 0)) & 0xff;

        // The pallet defaults the history to all-attended so a new participant
        // is not penalised for games played before they joined.
        const DEFAULT_HISTORY = 0xff;

        test("agrees with the runtime on its own vectors", () => {
            const clean = DEFAULT_HISTORY;
            expect([missesInWindow(clean, 8), missesInWindow(clean, 6)]).toEqual([0, 0]);
            expect(missesInWindow(clean, 1)).toBe(0);

            const oneMiss = store(clean, false);
            expect([
                missesInWindow(oneMiss, 1),
                missesInWindow(oneMiss, 2),
                missesInWindow(oneMiss, 8),
            ]).toEqual([1, 1, 1]);

            const missThenAttend = store(oneMiss, true);
            expect([missesInWindow(missThenAttend, 2), missesInWindow(missThenAttend, 1)]).toEqual([
                1, 0,
            ]);

            const aged = store(store(store(oneMiss, true), true), true);
            expect([missesInWindow(aged, 3), missesInWindow(aged, 4)]).toEqual([0, 1]);
        });

        test("clamps the window to the one-byte history width", () => {
            // The runtime debug-asserts a window of 8 or less and then clamps;
            // the policy arrives here straight off the chain, so clamp too.
            expect(missesInWindow(0x00, 8)).toBe(8);
            expect(missesInWindow(0x00, 99)).toBe(8);
            expect(missesInWindow(0x00, 0)).toBe(0);
            expect(missesInWindow(DEFAULT_HISTORY, -3)).toBe(0);
        });
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
            ).toEqual({ tag: "Candidate", score: 7, personhoodThreshold: 5, gamesRemaining: 0 });
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
            ).toEqual({ tag: "Candidate", score: 3, personhoodThreshold: 5, gamesRemaining: 1 });
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

        test("fail-safes to Suspended on a recognition variant it does not know", () => {
            // Callers may hand-build inputs that never met the decoder. Without
            // the default this returns `undefined`, not a PersonhoodState.
            expect(
                derivePersonhoodState(
                    snapshot({
                        participant: participant({
                            recognition:
                                "Revoked" as unknown as PersonhoodParticipant["recognition"],
                        }),
                    }),
                ),
            ).toEqual({ tag: "Suspended" });
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
            ).toEqual({ tag: "Candidate", score: 5, personhoodThreshold: 5, gamesRemaining: 0 });
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
        // --- gamesRemaining nonlinear cases ---------------------------------

        test("gamesRemaining: score 0 / threshold 6 / Attended streak → 3", () => {
            // streak=0: future adds 1+2+3 = 6; 3 games needed.
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 6,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 0,
                            streak: { tag: "Attended", count: 0 },
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 0, personhoodThreshold: 6, gamesRemaining: 3 });
        });

        test("gamesRemaining: score 3 / threshold 10 / Attended streak 2 → 2", () => {
            // streak=2: future adds 3+4 = 7; total 3+7=10; 2 games needed.
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 10,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 3,
                            streak: { tag: "Attended", count: 2 },
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 3, personhoodThreshold: 10, gamesRemaining: 2 });
        });

        test("gamesRemaining: score 6 / threshold 10 / Absent streak → 3", () => {
            // Absent streak: future starts at 1; 1+2+3 = 6; total 6+6=12≥10; 3 games needed.
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 10,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 6,
                            streak: { tag: "Absent", count: 3 },
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 6, personhoodThreshold: 10, gamesRemaining: 3 });
        });

        test("gamesRemaining: score 6 / threshold 10 / Attended streak 4 → 1", () => {
            // streak=4: future adds 5 = 5; total 6+5=11≥10; 1 game needed.
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 10,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 6,
                            streak: { tag: "Attended", count: 4 },
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 6, personhoodThreshold: 10, gamesRemaining: 1 });
        });

        test("gamesRemaining: score at or above threshold → 0 regardless of streak", () => {
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 10,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 10,
                            streak: { tag: "Absent", count: 99 },
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 10, personhoodThreshold: 10, gamesRemaining: 0 });
            // High score with a long attended streak: also 0, not negative.
            expect(
                derivePersonhoodState(
                    snapshot({
                        personhoodThreshold: 3,
                        participant: participant({
                            recognition: "NotRecognized",
                            reachedPersonhood: false,
                            score: 7,
                            streak: { tag: "Attended", count: 20 },
                        }),
                    }),
                ),
            ).toEqual({ tag: "Candidate", score: 7, personhoodThreshold: 3, gamesRemaining: 0 });
        });
    });
}
