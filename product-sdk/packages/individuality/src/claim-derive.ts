// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The claim predicate, pure, so a caller already holding a draw and a participant
 * need not re-fetch them. Also the one place the `last_attended_game` comparison
 * lives, which matters because the runtime may relax it.
 */
import type { AirdropDraw } from "./airdrop-types.js";
import type { ClaimBlocker, ClaimEligibility, ClaimWindow } from "./claim-types.js";
import type { PersonhoodParticipant } from "./types.js";

/** Everything the predicate needs, all from one pinned block. */
export interface ClaimInputs {
    /** The game the prize belongs to, which the chain compares attendance against. */
    gameIndex: number;
    /** The draw, as `readAirdropDraw` or `readPrizeStatus` returned it. */
    draw: AirdropDraw;
    /** `null` when `Score.Participants` holds no record for the claimant. */
    participant: PersonhoodParticipant | null;
    /**
     * Whether the prize asset is still enabled for airdrops, from
     * `Airdrop.SupportedAssets`. `false` blocks the claim on chain, so leaving it
     * out would let a `claimable: true` cost the player a fee.
     *
     * `null` means nothing to check: the draw's event row is gone and carries no
     * asset id. Not the same as disabled, and reporting it as such would name a
     * cause that is not true on top of the `DrawNotClaiming` that already fires.
     */
    prizeAssetEnabled: boolean | null;
    /**
     * Unix **seconds**, against the draw's `end_time`. An input rather than the
     * clock so a caller can pass the block's own time: a device clock minutes fast
     * will call a live window closed.
     */
    now: number;
}

/**
 * Recognition and `reachedPersonhood` are independent routes through this gate,
 * mirroring the pallet: `claim_airdrop` admits `p.recognition.is_recognized() ||
 * p.reached_personhood`. `is_recognized()` is false for `Suspended`, but the
 * `reached_personhood` route still rescues a suspended player — so the combined
 * check has to run *before* we single out `Suspended`, or we block a claimant
 * the runtime would accept.
 */
function personhoodBlocker(participant: PersonhoodParticipant | null): ClaimBlocker | null {
    if (participant === null) {
        return { tag: "NotAParticipant" };
    }
    const recognized =
        participant.recognition === "Recognized" ||
        participant.recognition === "ExternallyRecognized";
    if (recognized || participant.reachedPersonhood) {
        return null;
    }
    // Neither route passes: report the specific recognition state as the reason.
    return participant.recognition === "Suspended"
        ? { tag: "Suspended" }
        : { tag: "NotRecognized" };
}

/** Decide whether one prize can be claimed. Never throws. */
export function deriveClaimEligibility(inputs: ClaimInputs): ClaimEligibility {
    const { gameIndex, draw, participant, now } = inputs;
    const blockers: ClaimBlocker[] = [];

    const personhood = personhoodBlocker(participant);
    if (personhood !== null) {
        blockers.push(personhood);
    }

    // The attendance gate. A `null` record already produced NotAParticipant, and
    // repeating it as an attendance failure would double-count one cause.
    if (participant !== null && participant.lastAttendedGame !== gameIndex) {
        blockers.push({
            tag: "DidNotAttendThisGame",
            lastAttendedGame: participant.lastAttendedGame,
        });
    }

    // Only `Claiming` takes claims. Every other phase, including `Gone`, fails.
    if (draw.phase !== "Claiming") {
        blockers.push({ tag: "DrawNotClaiming", phase: draw.phase });
    }

    // `event` is null exactly when the row is gone, and DrawNotClaiming already
    // covers that, so the window is only checkable when there is an event.
    if (draw.event !== null && now >= draw.event.endTime) {
        blockers.push({ tag: "ClaimWindowClosed", endTime: draw.event.endTime });
    }

    // Only an explicit `false` blocks. `null` is "not checkable", which
    // `DrawNotClaiming` already covers.
    if (inputs.prizeAssetEnabled === false) {
        blockers.push({ tag: "PrizeAssetDisabled" });
    }

    if (draw.outcome.tag === "Unchecked") {
        blockers.push({ tag: "OutcomeUnchecked" });
    } else if (draw.outcome.tag === "NotWon") {
        blockers.push({ tag: "NoPrize" });
    }

    const ticket = draw.outcome.tag === "Won" ? draw.outcome.ticket : null;
    const window: ClaimWindow | null =
        draw.event === null ? null : { endTime: draw.event.endTime, closesOnNextAttendance: true };

    return { claimable: blockers.length === 0, blockers, ticket, window };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const EVENT_ID = `0x${"11".repeat(32)}`;
    const TICKET = `0x${"ee".repeat(32)}`;
    const END = 1_800_000_000;
    const NOW = END - 3_600;

    const participant = (
        overrides: Partial<PersonhoodParticipant> = {},
    ): PersonhoodParticipant => ({
        score: 10,
        streak: { tag: "Attended", count: 3 },
        attendanceHistory: 0xff,
        reachedPersonhood: true,
        recognition: "Recognized",
        lastAttendedGame: 41,
        ...overrides,
    });

    const draw = (overrides: Partial<AirdropDraw> = {}): AirdropDraw => ({
        at: { blockHash: `0x${"22".repeat(32)}`, blockNumber: 1 },
        eventId: EVENT_ID,
        phase: "Claiming",
        event: {
            eventId: EVENT_ID,
            status: "Claiming",
            phase: "Claiming",
            prize: {
                assetId: { parents: 1, interior: { type: "Here", value: undefined } },
                assetAmount: 100n,
                maxWinners: 5,
                winnerCapPermill: 10_000,
            },
            registrationStarts: END - 86_400,
            drawTime: END - 7_200,
            endTime: END,
            totalParticipants: 9,
            effectiveWinners: 2,
            claimed: 0,
            source: null,
        },
        outcome: { tag: "Won", ticket: TICKET },
        entropy: null,
        ...overrides,
    });

    const check = (overrides: Partial<ClaimInputs> = {}) =>
        deriveClaimEligibility({
            gameIndex: 41,
            draw: draw(),
            participant: participant(),
            prizeAssetEnabled: true,
            now: NOW,
            ...overrides,
        });

    describe("the claimable case", () => {
        test("a recognized winner inside the window can claim", () => {
            const result = check();
            expect(result.claimable).toBe(true);
            expect(result.blockers).toEqual([]);
            expect(result.ticket).toBe(TICKET);
        });

        test("personhood alone clears the first gate without recognition", () => {
            // The two routes are independent: `reached_personhood` passes on its
            // own, which is what the runtime's `||` says.
            const result = check({
                participant: participant({ recognition: "NotRecognized", reachedPersonhood: true }),
            });
            expect(result.claimable).toBe(true);
        });

        test("external recognition passes even with the personhood flag unset", () => {
            // Testing the flag before the variant gets this wrong, and it is the
            // one combination where the order of the two checks is observable.
            const result = check({
                participant: participant({
                    recognition: "ExternallyRecognized",
                    reachedPersonhood: false,
                }),
            });
            expect(result.claimable).toBe(true);
        });

        test("reports the window, including that playing again ends it", () => {
            expect(check().window).toEqual({ endTime: END, closesOnNextAttendance: true });
        });
    });

    describe("the personhood gate", () => {
        test("no participant record", () => {
            const result = check({ participant: null });
            expect(result.claimable).toBe(false);
            expect(result.blockers).toEqual([{ tag: "NotAParticipant" }]);
        });

        test("a missing record is not also reported as an attendance failure", () => {
            // One cause, one blocker. Listing both would send a UI two ways.
            expect(check({ participant: null }).blockers).toHaveLength(1);
        });

        test("suspended is its own blocker, not NotRecognized", () => {
            // Isolate the Suspended tag: personhood is off, so neither route
            // passes and the specific recognition state is the reported reason.
            const result = check({
                participant: participant({ recognition: "Suspended", reachedPersonhood: false }),
            });
            expect(result.blockers).toEqual([{ tag: "Suspended" }]);
        });

        test("personhood rescues a suspended player, matching the runtime's ||", () => {
            // `is_recognized()` is false for Suspended, but `claim_airdrop` admits
            // `is_recognized() || reached_personhood`, so the personhood route
            // still clears the gate.
            const result = check({
                participant: participant({ recognition: "Suspended", reachedPersonhood: true }),
            });
            expect(result.claimable).toBe(true);
            expect(result.blockers).toEqual([]);
        });

        test("neither recognized nor at personhood", () => {
            const result = check({
                participant: participant({
                    recognition: "NotRecognized",
                    reachedPersonhood: false,
                }),
            });
            expect(result.blockers).toEqual([{ tag: "NotRecognized" }]);
        });
    });

    describe("the attendance gate", () => {
        test("a later game closed the claim", () => {
            const result = check({ participant: participant({ lastAttendedGame: 42 }) });
            expect(result.blockers).toEqual([
                { tag: "DidNotAttendThisGame", lastAttendedGame: 42 },
            ]);
        });

        test("an earlier game also fails, because the chain compares for equality", () => {
            // Not a "too old" check: the runtime tests `==`, so any mismatch
            // fails in either direction.
            const result = check({ participant: participant({ lastAttendedGame: 40 }) });
            expect(result.blockers).toEqual([
                { tag: "DidNotAttendThisGame", lastAttendedGame: 40 },
            ]);
        });

        test("never having attended fails too", () => {
            const result = check({ participant: participant({ lastAttendedGame: null }) });
            expect(result.blockers).toEqual([
                { tag: "DidNotAttendThisGame", lastAttendedGame: null },
            ]);
        });
    });

    describe("the draw gates", () => {
        test.each(["Upcoming", "Registering", "Drawing", "Settling", "Gone"] as const)(
            "phase %s does not take claims",
            (phase) => {
                const result = check({ draw: draw({ phase }) });
                expect(result.blockers).toContainEqual({ tag: "DrawNotClaiming", phase });
            },
        );

        test("a gone draw reports the phase but no window", () => {
            const result = check({ draw: draw({ phase: "Gone", event: null }) });
            expect(result.window).toBeNull();
            expect(result.blockers).toContainEqual({ tag: "DrawNotClaiming", phase: "Gone" });
            // And no ClaimWindowClosed: with no event there is no end_time to be
            // past, and inventing one would double-report the same cause.
            expect(result.blockers.some((b) => b.tag === "ClaimWindowClosed")).toBe(false);
        });

        test("past end_time closes the window", () => {
            const result = check({ now: END });
            expect(result.blockers).toContainEqual({ tag: "ClaimWindowClosed", endTime: END });
        });

        test("the boundary is exclusive, matching the chain's `<`", () => {
            expect(check({ now: END - 1 }).claimable).toBe(true);
            expect(check({ now: END }).claimable).toBe(false);
        });

        test("no winning entry", () => {
            const result = check({ draw: draw({ outcome: { tag: "NotWon" } }) });
            expect(result.blockers).toEqual([{ tag: "NoPrize" }]);
            expect(result.ticket).toBeNull();
        });

        test("an unchecked draw is its own blocker, not NoPrize", () => {
            // The read never asked, so claiming that there is no prize would be a
            // claim it never made.
            const result = check({ draw: draw({ outcome: { tag: "Unchecked" } }) });
            expect(result.blockers).toEqual([{ tag: "OutcomeUnchecked" }]);
        });
    });

    describe("the prize-asset gate", () => {
        test("a disabled prize asset blocks the claim", () => {
            // Blocks locally because a refused claim pays a fee.
            const result = check({ prizeAssetEnabled: false });
            expect(result.claimable).toBe(false);
            expect(result.blockers).toEqual([{ tag: "PrizeAssetDisabled" }]);
        });

        test("an enabled asset adds no blocker", () => {
            expect(check({ prizeAssetEnabled: true }).claimable).toBe(true);
        });

        test("nothing to check is not the same as disabled", () => {
            // A gone draw carries no asset id, so the gate is not applicable.
            const result = check({
                draw: draw({ phase: "Gone", event: null }),
                prizeAssetEnabled: null,
            });
            expect(result.blockers.map((b) => b.tag)).toEqual(["DrawNotClaiming"]);
        });
    });

    describe("several blockers at once", () => {
        test("collects every independent cause", () => {
            const result = check({
                participant: participant({
                    recognition: "NotRecognized",
                    reachedPersonhood: false,
                    lastAttendedGame: 42,
                }),
                draw: draw({ phase: "Settling", outcome: { tag: "NotWon" } }),
                now: END + 1,
            });
            expect(result.blockers.map((b) => b.tag).sort()).toEqual([
                "ClaimWindowClosed",
                "DidNotAttendThisGame",
                "DrawNotClaiming",
                "NoPrize",
                "NotRecognized",
            ]);
        });

        test("claimable is false whenever anything blocks", () => {
            expect(check({ now: END }).claimable).toBe(false);
        });
    });
}
