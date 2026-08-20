// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Raw `Airdrop` storage values → domain shapes. An unknown enum variant throws
 * rather than map to something plausible: a new lifecycle state must not render as
 * the wrong phase.
 *
 * Two traps the compiler cannot see. `Status` carries its counters in some variants
 * and not others (`AirdropEvent` has the table), so `?? 0` is a lie; and the `u64`
 * timestamps throw rather than round, because a rounded one looks real.
 */
import { IndividualityDecodeError } from "./errors.js";
import type {
    AirdropAssetId,
    AirdropEvent,
    AirdropPhase,
    AirdropPrize,
    AirdropRegistrant,
    AirdropStatusTag,
} from "./airdrop-types.js";

/** The raw `AirdropPrize`, narrowed to the fields the domain carries. */
export interface RawAirdropPrize {
    asset_id: AirdropAssetId;
    asset_amount: bigint;
    max_winners: number;
    winner_cap: number;
}

/** The raw `EventInfo`. Every timestamp is a `u64` of Unix **seconds**. */
export interface RawAirdropEventInfo {
    prize: RawAirdropPrize;
    registration_starts: bigint;
    draw_time: bigint;
    end_time: bigint;
}

/**
 * The raw `Status` enum. The payload is loose on purpose: enumerating eight
 * variants' field sets would duplicate the descriptor and catch nothing the
 * availability rules above miss.
 */
export interface RawAirdropStatus {
    type: string;
    value?: {
        total_participants?: number;
        effective_winners?: number;
        claimed?: number;
    };
}

/**
 * The raw `Airdrop.Events` value, narrowed to what the domain reads.
 *
 * Extra fields on the actual value are accepted — this is a structural type, not
 * an exhaustive record of the storage entry.
 */
export interface RawActiveEvent {
    id: string;
    info: RawAirdropEventInfo;
    status: RawAirdropStatus;
    source?: string | undefined;
}

/** The raw `RegistrationEntry` enum, the key `Winners` is addressed by. */
export type RawRegistrationEntry =
    | { type: "Alias"; value: { alias: string } }
    | { type: "Account"; value: { account_id: string } };

/**
 * `Status` collapsed to the phase a product renders. A lookup rather than a
 * `switch` so a new {@link AirdropStatusTag} fails to compile here — classifying it
 * is the one decision that must not be skippable.
 */
const PHASE_OF_STATUS: Record<AirdropStatusTag, AirdropPhase> = {
    Scheduled: "Upcoming",
    Registering: "Registering",
    // Both are "closed, winners not final". The chain distinguishes waiting for
    // randomness from assigning winners; a product does not.
    AwaitingEntropy: "Drawing",
    DrawWinners: "Drawing",
    Claiming: "Claiming",
    // All three clean-up states are over-and-nothing-to-do. Claims closed at
    // `endTime`, which is what moved the draw out of `Claiming`.
    ClearingRegistrations: "Settling",
    ClearingWinners: "Settling",
    Finalizing: "Settling",
};

/**
 * Validate a raw `Status` variant name.
 *
 * The domain tags match the chain's variant names exactly, so this narrows
 * rather than translates.
 */
function statusTag(type: string): AirdropStatusTag {
    if (type in PHASE_OF_STATUS) {
        return type as AirdropStatusTag;
    }
    // Fixed message: never echo chain data. Same rule at every throw here.
    throw new IndividualityDecodeError("unknown airdrop status variant");
}

export function airdropPhase(status: AirdropStatusTag): AirdropPhase {
    return PHASE_OF_STATUS[status];
}

/**
 * Narrow a `u64` of Unix seconds, rejecting anything a JS number cannot hold
 * exactly — a rounded timestamp is indistinguishable from a real one.
 */
function toUnixSeconds(value: bigint): number {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) {
        throw new IndividualityDecodeError("airdrop timestamp is out of range");
    }
    return seconds;
}

/** Exported for `game-decode.ts`: a game schedule carries this same shape per draw. */
export function toAirdropPrize(raw: RawAirdropPrize): AirdropPrize {
    return {
        assetId: raw.asset_id,
        assetAmount: raw.asset_amount,
        maxWinners: raw.max_winners,
        winnerCapPermill: raw.winner_cap,
    };
}

/**
 * @param eventId - the key the row was read under, rather than `raw.id`; the two
 *   agreeing is asserted below, not assumed.
 * @throws IndividualityDecodeError on an unknown status variant, an out-of-range
 *   timestamp, or an `id` that disagrees with the key.
 */
export function toAirdropEvent(eventId: string, raw: RawActiveEvent): AirdropEvent {
    // The id is stored in the value as well as the key, so a mismatch means a
    // misaddressed read or a wrong descriptor — both worth failing on.
    if (raw.id.toLowerCase() !== eventId.toLowerCase()) {
        throw new IndividualityDecodeError(
            "airdrop event id does not match the key it was read under",
        );
    }

    const status = statusTag(raw.status.type);
    // Undefined in every state that has not computed the figure yet, and
    // `undefined` is not `0`: see trap 1 in the module doc.
    const counters = raw.status.value;

    return {
        eventId,
        status,
        phase: airdropPhase(status),
        prize: toAirdropPrize(raw.info.prize),
        registrationStarts: toUnixSeconds(raw.info.registration_starts),
        drawTime: toUnixSeconds(raw.info.draw_time),
        endTime: toUnixSeconds(raw.info.end_time),
        totalParticipants: counters?.total_participants ?? null,
        effectiveWinners: counters?.effective_winners ?? null,
        claimed: counters?.claimed ?? null,
        source: raw.source ?? null,
    };
}

/** A domain registrant as the `Winners` key wants it. */
export function toRawRegistrationEntry(registrant: AirdropRegistrant): RawRegistrationEntry {
    return registrant.tag === "Alias"
        ? { type: "Alias", value: { alias: registrant.alias } }
        : { type: "Account", value: { account_id: registrant.accountAddress } };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const EVENT_ID = `0x${"11".repeat(32)}`;

    const rawPrize = (overrides: Partial<RawAirdropPrize> = {}): RawAirdropPrize => ({
        asset_id: { parents: 1, interior: { type: "Here", value: undefined } },
        asset_amount: 1_000_000_000_000n,
        max_winners: 500,
        winner_cap: 25_000,
        ...overrides,
    });

    const rawEvent = (overrides: Partial<RawActiveEvent> = {}): RawActiveEvent => ({
        id: EVENT_ID,
        info: {
            prize: rawPrize(),
            registration_starts: 1_770_000_000n,
            draw_time: 1_770_003_600n,
            end_time: 1_770_090_000n,
        },
        status: {
            type: "Claiming",
            value: { total_participants: 40, effective_winners: 10, claimed: 3 },
        },
        source: undefined,
        ...overrides,
    });

    describe("airdropPhase", () => {
        test.each([
            ["Scheduled", "Upcoming"],
            ["Registering", "Registering"],
            ["AwaitingEntropy", "Drawing"],
            ["DrawWinners", "Drawing"],
            ["Claiming", "Claiming"],
            ["ClearingRegistrations", "Settling"],
            ["ClearingWinners", "Settling"],
            ["Finalizing", "Settling"],
        ] as Array<[AirdropStatusTag, AirdropPhase]>)("maps %s to %s", (status, phase) => {
            expect(airdropPhase(status)).toBe(phase);
        });

        test("covers all eight chain variants", () => {
            // A ninth variant added to the union without a phase would fail the
            // Record's type check, but a variant *removed* from the mapping
            // would not — this pins the count.
            expect(Object.keys(PHASE_OF_STATUS)).toHaveLength(8);
        });
    });

    describe("toAirdropEvent", () => {
        test("maps every field of a representative event", () => {
            expect(toAirdropEvent(EVENT_ID, rawEvent())).toEqual({
                eventId: EVENT_ID,
                status: "Claiming",
                phase: "Claiming",
                prize: {
                    assetId: { parents: 1, interior: { type: "Here", value: undefined } },
                    assetAmount: 1_000_000_000_000n,
                    maxWinners: 500,
                    winnerCapPermill: 25_000,
                },
                registrationStarts: 1_770_000_000,
                drawTime: 1_770_003_600,
                endTime: 1_770_090_000,
                totalParticipants: 40,
                effectiveWinners: 10,
                claimed: 3,
                source: null,
            });
        });

        test("carries the funding source when the event has one", () => {
            const account = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
            expect(toAirdropEvent(EVENT_ID, rawEvent({ source: account })).source).toBe(account);
        });

        // The availability rules, one test per absent field. Each of these is a
        // state a normal draw passes through, so `?? 0` here would be wrong in
        // production rather than in a corner case.
        test("Scheduled carries no counters at all", () => {
            const event = toAirdropEvent(EVENT_ID, rawEvent({ status: { type: "Scheduled" } }));
            expect(event.totalParticipants).toBeNull();
            expect(event.effectiveWinners).toBeNull();
            expect(event.claimed).toBeNull();
        });

        test("Registering carries participants but no winners and no claims", () => {
            const event = toAirdropEvent(
                EVENT_ID,
                rawEvent({ status: { type: "Registering", value: { total_participants: 12 } } }),
            );
            expect(event.totalParticipants).toBe(12);
            expect(event.effectiveWinners).toBeNull();
            expect(event.claimed).toBeNull();
        });

        test("DrawWinners carries both counts but no claims yet", () => {
            const event = toAirdropEvent(
                EVENT_ID,
                rawEvent({
                    status: {
                        type: "DrawWinners",
                        value: { total_participants: 12, effective_winners: 4 },
                    },
                }),
            );
            expect(event.totalParticipants).toBe(12);
            expect(event.effectiveWinners).toBe(4);
            expect(event.claimed).toBeNull();
        });

        test("Finalizing drops the participant count but keeps winners and claims", () => {
            const event = toAirdropEvent(
                EVENT_ID,
                rawEvent({
                    status: { type: "Finalizing", value: { effective_winners: 4, claimed: 2 } },
                }),
            );
            // Not zero: the draw had participants, the chain stopped carrying
            // the figure.
            expect(event.totalParticipants).toBeNull();
            expect(event.effectiveWinners).toBe(4);
            expect(event.claimed).toBe(2);
        });

        test("keeps a zero counter distinct from an absent one", () => {
            const event = toAirdropEvent(
                EVENT_ID,
                rawEvent({ status: { type: "Registering", value: { total_participants: 0 } } }),
            );
            expect(event.totalParticipants).toBe(0);
        });

        test("throws on an unknown status variant", () => {
            expect(() =>
                toAirdropEvent(EVENT_ID, rawEvent({ status: { type: "Reconciling" } })),
            ).toThrow(IndividualityDecodeError);
        });

        test("never interpolates chain data into a decode error message", () => {
            expect(() =>
                toAirdropEvent(
                    EVENT_ID,
                    rawEvent({ status: { type: "Reconciling", value: { claimed: 99 } } }),
                ),
            ).toThrow(/^unknown airdrop status variant$/);
        });

        test("throws when the row's own id disagrees with the key", () => {
            expect(() =>
                toAirdropEvent(EVENT_ID, rawEvent({ id: `0x${"22".repeat(32)}` })),
            ).toThrow(IndividualityDecodeError);
        });

        test("accepts an id that differs only in hex case", () => {
            expect(() =>
                toAirdropEvent(EVENT_ID.toUpperCase().replace("0X", "0x"), rawEvent()),
            ).not.toThrow();
        });

        test("throws on a timestamp beyond safe-integer range", () => {
            const raw = rawEvent();
            raw.info.draw_time = 2n ** 63n;
            expect(() => toAirdropEvent(EVENT_ID, raw)).toThrow(IndividualityDecodeError);
        });

        test("accepts a zero timestamp, which is a real chain value", () => {
            const raw = rawEvent();
            raw.info.registration_starts = 0n;
            expect(toAirdropEvent(EVENT_ID, raw).registrationStarts).toBe(0);
        });
    });

    describe("toRawRegistrationEntry", () => {
        test("maps an alias registrant to the Alias variant", () => {
            const alias = `0x${"ab".repeat(32)}`;
            expect(toRawRegistrationEntry({ tag: "Alias", alias })).toEqual({
                type: "Alias",
                value: { alias },
            });
        });

        test("maps an account registrant to the Account variant", () => {
            const accountAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
            expect(toRawRegistrationEntry({ tag: "Account", accountAddress })).toEqual({
                type: "Account",
                value: { account_id: accountAddress },
            });
        });
    });
}
