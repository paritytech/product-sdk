// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The pinned prize-draw read: one event id in, one {@link AirdropDraw} out. Ids come
 * from `airdrop-ids.ts`, or from {@link readGameAirdropEventIds}.
 *
 * **Every read shares one finalized block.** A draw's phase and its winner set move
 * together, so reading them a block apart can report a draw as still `Registering`
 * while it already holds its winners.
 *
 * `Registrations` is read only by {@link readDrawRegistration}: it is keyed by the
 * entropy slot with the entry as its value, so "am I registered" means scanning the
 * event's whole prefix — unbounded client-side, and no business in a polled status.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import {
    toAirdropEvent,
    toRawRegistrationEntry,
    type RawActiveEvent,
    type RawRegistrationEntry,
} from "./airdrop-decode.js";
import { gameAirdropEventIds } from "./airdrop-ids.js";
import type { AirdropDraw, AirdropOutcome, AirdropRegistrant } from "./airdrop-types.js";
import { ProductIndividualityError } from "./errors.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import type { FinalizedSnapshot } from "./types.js";

/**
 * Structural, so a test double satisfies it. See `IndividualityChain` in `read.ts`
 * for the conventions and where the fidelity guard lives.
 *
 * Matched by hand against the paseo descriptors on 2026-08-20:
 *
 * ```
 * Game.airdrop_event_id_base: PlainDescriptor<SizedHex<27>>
 * Airdrop.Events:             StorageDescriptor<[Key: SizedHex<32>], ActiveEvent, true, never>
 * Airdrop.Winners:            StorageDescriptor<[SizedHex<32>, RegistrationEntry], SizedHex<32>, true, never>
 * Airdrop.EventEntropy:       StorageDescriptor<[Key: SizedHex<32>], SizedHex<32>, true, never>
 * ```
 */
export interface AirdropChain extends PinnedChain {
    individuality: {
        constants: {
            Game: {
                /** 27-byte base, `0x`-prefixed hex. */
                airdrop_event_id_base(): Promise<string>;
            };
        };
        query: {
            Airdrop: {
                Events: {
                    getValue(eventId: string, options: ReadAt): Promise<RawActiveEvent | undefined>;
                };
                Winners: {
                    getValue(
                        eventId: string,
                        entry: RawRegistrationEntry,
                        options: ReadAt,
                    ): Promise<string | undefined>;
                };
                EventEntropy: {
                    getValue(eventId: string, options: ReadAt): Promise<string | undefined>;
                };
                /**
                 * Keyed by the entropy slot with the entry as its value, so only
                 * a prefix scan can answer "is this identity registered".
                 */
                Registrations: {
                    getEntries(
                        eventId: string,
                        options: ReadAt,
                    ): Promise<Array<{ keyArgs: [string, string]; value: RawRegistrationEntry }>>;
                };
            };
        };
    };
}

/** Options for {@link readAirdropDraw}. */
export interface ReadAirdropDrawOptions {
    /**
     * The 32-byte event id, `0x`-prefixed. Derive it with `gameAirdropEventId`
     * or `peopleAirdropsEventId` — no storage entry lists it.
     */
    eventId: string;
    /**
     * Whose outcome to look up. Omit it to read the draw itself without asking
     * about anyone, which returns `outcome: { tag: "Unchecked" }` rather than a
     * `false` that would read as "did not win".
     */
    registrant?: AirdropRegistrant;
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the whole
     * batch. No deadline is applied here — that belongs to the caller.
     */
    signal?: AbortSignal;
}

/**
 * **A draw that is not in storage is not a failure**, it is `phase: "Gone"` — the
 * steady state for every past draw. Not evidence the draw existed either: an id
 * that was never scheduled answers identically.
 */
export async function readAirdropDraw(
    chain: AirdropChain,
    options: ReadAirdropDrawOptions,
): Promise<Result<AirdropDraw, ProductIndividualityError>> {
    try {
        return ok(await runDrawRead(chain, options));
    } catch (cause) {
        // normalizeError passes an existing package error through unchanged, so
        // callers can still narrow with isErrorOf.
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/**
 * The read itself. Throws; {@link readAirdropDraw} owns the `Result` boundary.
 *
 * Exported so `prize-status.ts` can run it against a block it already pinned.
 */
export async function runDrawRead(
    chain: AirdropChain,
    options: ReadAirdropDrawOptions,
    pinned?: FinalizedSnapshot,
): Promise<AirdropDraw> {
    const { eventId, registrant, signal } = options;
    const query = chain.individuality.query.Airdrop;

    const snapshot = await pinBlock(chain, signal, pinned);
    const at: ReadAt = readAt(snapshot, signal);

    // One round trip, three entries, one block. The winner lookup is a point
    // read rather than a scan because `Winners` hashes the registration entry —
    // which is why an identity is all it takes.
    const [rawEvent, ticket, entropy] = await Promise.all([
        query.Events.getValue(eventId, at),
        registrant === undefined
            ? Promise.resolve(undefined)
            : query.Winners.getValue(eventId, toRawRegistrationEntry(registrant), at),
        query.EventEntropy.getValue(eventId, at),
    ]);

    const event = rawEvent === undefined ? null : toAirdropEvent(eventId, rawEvent);

    return {
        at: snapshot,
        eventId,
        // "Gone" is the absence of the row, not a status the chain reports.
        phase: event?.phase ?? "Gone",
        event,
        outcome: toOutcome(registrant, ticket),
        entropy: entropy ?? null,
    };
}

function toOutcome(
    registrant: AirdropRegistrant | undefined,
    ticket: string | undefined,
): AirdropOutcome {
    if (registrant === undefined) {
        return { tag: "Unchecked" };
    }
    return ticket === undefined ? { tag: "NotWon" } : { tag: "Won", ticket };
}

/** One draw's registration for one identity. */
export interface DrawRegistration {
    at: FinalizedSnapshot;
    eventId: string;
    /**
     * The entropy slot the registration is stored under, or `null` when this
     * identity has none. The slot is also the draw ticket.
     */
    slot: string | null;
    /**
     * Entries the scan walked. Reported because it is the cost of the call, and
     * nothing bounds it below the draw's participant count.
     */
    entriesScanned: number;
}

/**
 * Whether an identity entered a draw, which {@link readAirdropDraw} cannot say: an
 * absent `Winners` entry before the draw means "not drawn yet", not "did not enter".
 *
 * **A prefix scan, hence a separate call** — the cost grows with the participant
 * count, so this is for "you are in tonight's draw", not for every status poll. The
 * personhood path could point-read it, but is gated on the `PeopleAirdrops` blockers.
 */
export async function readDrawRegistration(
    chain: AirdropChain,
    options: { eventId: string; registrant: AirdropRegistrant; signal?: AbortSignal },
): Promise<Result<DrawRegistration, ProductIndividualityError>> {
    try {
        const { eventId, registrant, signal } = options;
        const snapshot = await pinBlock(chain, signal);
        const entries = await chain.individuality.query.Airdrop.Registrations.getEntries(
            eventId,
            readAt(snapshot, signal),
        );

        const wanted = toRawRegistrationEntry(registrant);
        const match = entries.find(
            (entry) =>
                entry.value.type === wanted.type &&
                identityOf(entry.value).toLowerCase() === identityOf(wanted).toLowerCase(),
        );

        return ok({
            at: snapshot,
            eventId,
            // keyArgs is [eventId, slot], so the slot is the second key.
            slot: match?.keyArgs[1] ?? null,
            entriesScanned: entries.length,
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

function identityOf(entry: RawRegistrationEntry): string {
    return entry.type === "Alias" ? entry.value.alias : entry.value.account_id;
}

/** Options for {@link readGameAirdropEventIds}. */
export interface ReadGameAirdropEventIdsOptions {
    /** The game the draws belong to. */
    gameIndex: number;
    /**
     * `Game.Game.airdrops_scheduled`, **readable only while the game is current** —
     * capture it then, because a past game's count is unrecoverable. Probing ids
     * upward cannot tell a cleaned-up draw from one never scheduled.
     */
    airdropsScheduled: number;
}

/**
 * Every event id of one game's draws, with the base read from the chain rather
 * than assumed. That is the point of it: a hardcoded copy would go on deriving ids
 * for draws that do not exist if the base ever moved.
 */
export async function readGameAirdropEventIds(
    chain: AirdropChain,
    options: ReadGameAirdropEventIdsOptions,
): Promise<Result<string[], ProductIndividualityError>> {
    try {
        const base = await chain.individuality.constants.Game.airdrop_event_id_base();
        return ok(
            gameAirdropEventIds({
                base,
                gameIndex: options.gameIndex,
                airdropsScheduled: options.airdropsScheduled,
            }),
        );
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapOk, unwrapErr, isErrorOf } = await import("@parity/result");
    const { IndividualityDecodeError } = await import("./errors.js");
    const { GAME_AIRDROP_EVENT_ID_BASE, gameAirdropEventId } = await import("./airdrop-ids.js");

    const EVENT_ID = `0x${"11".repeat(32)}`;
    const TICKET = `0x${"ee".repeat(32)}`;
    const ENTROPY = `0x${"77".repeat(32)}`;
    const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const ALIAS = `0x${"ab".repeat(32)}`;
    const BLOCK = { hash: `0x${"33".repeat(32)}`, number: 9_100 };

    const rawEvent = (overrides: Partial<RawActiveEvent> = {}): RawActiveEvent => ({
        id: EVENT_ID,
        info: {
            prize: {
                asset_id: { parents: 1, interior: { type: "Here", value: undefined } },
                asset_amount: 500n,
                max_winners: 10,
                winner_cap: 100_000,
            },
            registration_starts: 1_770_000_000n,
            draw_time: 1_770_003_600n,
            end_time: 1_770_090_000n,
        },
        status: { type: "Registering", value: { total_participants: 6 } },
        ...overrides,
    });

    interface FakeState {
        event?: RawActiveEvent;
        /** Winning tickets, keyed by the JSON of the raw registration entry. */
        winners?: Record<string, string>;
        entropy?: string;
        base?: string;
        /** `Registrations` rows under the event, as the prefix scan sees them. */
        registrations?: Array<{ keyArgs: [string, string]; value: RawRegistrationEntry }>;
        failOn?: "Events" | "Winners" | "EventEntropy" | "Registrations" | "constant" | "block";
    }

    /**
     * Records each read's key and options: a read addressed with the wrong event id,
     * or a winner lookup with the wrong entry shape, satisfies every other
     * assertion here.
     */
    function fakeChain(state: FakeState) {
        const calls: Array<{ entry: string; key: unknown; at: string | undefined }> = [];
        const boom = (entry: FakeState["failOn"]) => {
            if (state.failOn === entry) throw new Error(`${entry} unreachable`);
        };
        const record = (entry: string, key: unknown, options: ReadAt) => {
            options.signal?.throwIfAborted();
            calls.push({ entry, key, at: options.at });
        };

        const chain: AirdropChain = {
            individuality: {
                constants: {
                    Game: {
                        airdrop_event_id_base: async () => {
                            boom("constant");
                            return state.base ?? GAME_AIRDROP_EVENT_ID_BASE;
                        },
                    },
                },
                query: {
                    Airdrop: {
                        Events: {
                            getValue: async (eventId, options) => {
                                boom("Events");
                                record("Events", eventId, options);
                                return state.event;
                            },
                        },
                        Winners: {
                            getValue: async (eventId, entry, options) => {
                                boom("Winners");
                                record("Winners", [eventId, entry], options);
                                return state.winners?.[JSON.stringify(entry)];
                            },
                        },
                        EventEntropy: {
                            getValue: async (eventId, options) => {
                                boom("EventEntropy");
                                record("EventEntropy", eventId, options);
                                return state.entropy;
                            },
                        },
                        Registrations: {
                            getEntries: async (eventId, options) => {
                                boom("Registrations");
                                record("Registrations", eventId, options);
                                return state.registrations ?? [];
                            },
                        },
                    },
                },
            },
            raw: {
                individuality: {
                    getFinalizedBlock: async () => {
                        boom("block");
                        return BLOCK;
                    },
                },
            },
        };
        return { chain, calls };
    }

    describe("readAirdropDraw", () => {
        test("returns the decoded event with its phase", async () => {
            const { chain } = fakeChain({ event: rawEvent() });
            const draw = unwrapOk(await readAirdropDraw(chain, { eventId: EVENT_ID }));

            expect(draw.eventId).toBe(EVENT_ID);
            expect(draw.phase).toBe("Registering");
            expect(draw.event?.status).toBe("Registering");
            expect(draw.event?.totalParticipants).toBe(6);
        });

        test("reports the pinned block, and reads every entry at it", async () => {
            const { chain, calls } = fakeChain({ event: rawEvent(), entropy: ENTROPY });
            const draw = unwrapOk(
                await readAirdropDraw(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );

            expect(draw.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
            expect(calls).toHaveLength(3);
            // The whole reason the block is pinned: three entries, one block.
            expect(new Set(calls.map((call) => call.at))).toEqual(new Set([BLOCK.hash]));
        });

        test("addresses every read with the event id it was given", async () => {
            const { chain, calls } = fakeChain({ event: rawEvent() });
            await readAirdropDraw(chain, {
                eventId: EVENT_ID,
                registrant: { tag: "Alias", alias: ALIAS },
            });

            expect(calls.find((call) => call.entry === "Events")?.key).toBe(EVENT_ID);
            expect(calls.find((call) => call.entry === "EventEntropy")?.key).toBe(EVENT_ID);
            expect(calls.find((call) => call.entry === "Winners")?.key).toEqual([
                EVENT_ID,
                { type: "Alias", value: { alias: ALIAS } },
            ]);
        });

        test("looks a winner up by the account entry for an account registrant", async () => {
            const entry = { type: "Account", value: { account_id: ALICE } };
            const { chain } = fakeChain({
                event: rawEvent(),
                winners: { [JSON.stringify(entry)]: TICKET },
            });

            const draw = unwrapOk(
                await readAirdropDraw(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(draw.outcome).toEqual({ tag: "Won", ticket: TICKET });
        });

        test("looks a winner up by the alias entry for an alias registrant", async () => {
            const entry = { type: "Alias", value: { alias: ALIAS } };
            const { chain } = fakeChain({
                event: rawEvent(),
                winners: { [JSON.stringify(entry)]: TICKET },
            });

            const draw = unwrapOk(
                await readAirdropDraw(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Alias", alias: ALIAS },
                }),
            );
            expect(draw.outcome).toEqual({ tag: "Won", ticket: TICKET });
        });

        test("a registrant with no winning entry is NotWon", async () => {
            const { chain } = fakeChain({ event: rawEvent() });
            const draw = unwrapOk(
                await readAirdropDraw(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(draw.outcome).toEqual({ tag: "NotWon" });
        });

        test("no registrant means Unchecked, and no winner read at all", async () => {
            const { chain, calls } = fakeChain({ event: rawEvent() });
            const draw = unwrapOk(await readAirdropDraw(chain, { eventId: EVENT_ID }));

            // Unchecked rather than NotWon: the question was never asked, and a
            // `false` here would be a claim the read never made.
            expect(draw.outcome).toEqual({ tag: "Unchecked" });
            expect(calls.some((call) => call.entry === "Winners")).toBe(false);
        });

        test("a missing event row is Gone, on the ok channel", async () => {
            const { chain } = fakeChain({});
            const draw = unwrapOk(await readAirdropDraw(chain, { eventId: EVENT_ID }));

            // The steady state for every past draw, and indistinguishable from
            // an id that was never scheduled.
            expect(draw.phase).toBe("Gone");
            expect(draw.event).toBeNull();
        });

        test("a win still reads after the event row is gone", async () => {
            const entry = { type: "Account", value: { account_id: ALICE } };
            const { chain } = fakeChain({ winners: { [JSON.stringify(entry)]: TICKET } });

            const draw = unwrapOk(
                await readAirdropDraw(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(draw.phase).toBe("Gone");
            expect(draw.outcome).toEqual({ tag: "Won", ticket: TICKET });
        });

        test("carries the entropy when the draw has run, and null before", async () => {
            const withEntropy = fakeChain({ event: rawEvent(), entropy: ENTROPY });
            expect(
                unwrapOk(await readAirdropDraw(withEntropy.chain, { eventId: EVENT_ID })).entropy,
            ).toBe(ENTROPY);

            const without = fakeChain({ event: rawEvent() });
            expect(
                unwrapOk(await readAirdropDraw(without.chain, { eventId: EVENT_ID })).entropy,
            ).toBeNull();
        });

        test("an unknown status variant arrives as a decode error", async () => {
            const { chain } = fakeChain({ event: rawEvent({ status: { type: "Reconciling" } }) });
            const error = unwrapErr(await readAirdropDraw(chain, { eventId: EVENT_ID }));

            expect(isErrorOf(error, IndividualityDecodeError)).toBe(true);
        });

        test("a transport failure arrives on the err channel with its cause", async () => {
            const { chain } = fakeChain({ failOn: "Events" });
            const error = unwrapErr(await readAirdropDraw(chain, { eventId: EVENT_ID }));

            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect((error.cause as Error).message).toBe("Events unreachable");
        });

        test("an already-aborted signal costs no round trip", async () => {
            const { chain, calls } = fakeChain({ event: rawEvent() });
            const controller = new AbortController();
            controller.abort();

            const error = unwrapErr(
                await readAirdropDraw(chain, { eventId: EVENT_ID, signal: controller.signal }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(calls).toHaveLength(0);
        });
    });

    describe("readGameAirdropEventIds", () => {
        test("derives one id per scheduled draw from the chain's own base", async () => {
            const { chain } = fakeChain({});
            const ids = unwrapOk(
                await readGameAirdropEventIds(chain, { gameIndex: 4, airdropsScheduled: 2 }),
            );

            expect(ids).toEqual([
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 4,
                    airdropIndex: 0,
                }),
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 4,
                    airdropIndex: 1,
                }),
            ]);
        });

        test("uses the base the chain reports, not the pinned constant", async () => {
            // A base the chain could plausibly move to. If the pinned constant
            // were used instead, this test would pass with the wrong ids.
            const base = `0x${"5f".repeat(27)}`;
            const { chain } = fakeChain({ base });
            const ids = unwrapOk(
                await readGameAirdropEventIds(chain, { gameIndex: 1, airdropsScheduled: 1 }),
            );

            expect(ids).toEqual([gameAirdropEventId({ base, gameIndex: 1, airdropIndex: 0 })]);
            expect(ids[0]).not.toBe(
                gameAirdropEventId({
                    base: GAME_AIRDROP_EVENT_ID_BASE,
                    gameIndex: 1,
                    airdropIndex: 0,
                }),
            );
        });

        test("a failure reading the constant arrives on the err channel", async () => {
            const { chain } = fakeChain({ failOn: "constant" });
            const error = unwrapErr(
                await readGameAirdropEventIds(chain, { gameIndex: 1, airdropsScheduled: 1 }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });

        test("a count above MAX_GAME_AIRDROPS arrives on the err channel, not as a throw", async () => {
            const { chain } = fakeChain({});
            const error = unwrapErr(
                await readGameAirdropEventIds(chain, { gameIndex: 1, airdropsScheduled: 17 }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });
    });

    describe("readDrawRegistration", () => {
        const SLOT = `0x${"a1".repeat(32)}`;
        const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

        const rows = (
            ...entries: RawRegistrationEntry[]
        ): Array<{ keyArgs: [string, string]; value: RawRegistrationEntry }> =>
            entries.map((value, index) => ({
                keyArgs: [EVENT_ID, index === 0 ? SLOT : `0x${String(index).repeat(64)}`],
                value,
            }));

        test("finds an account registrant and returns its slot", async () => {
            const { chain } = fakeChain({
                registrations: rows({ type: "Account", value: { account_id: ALICE } }),
            });
            const registration = unwrapOk(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );

            expect(registration.slot).toBe(SLOT);
            expect(registration.entriesScanned).toBe(1);
        });

        test("finds an alias registrant and returns its slot", async () => {
            const { chain } = fakeChain({
                registrations: rows({ type: "Alias", value: { alias: ALIAS } }),
            });
            const registration = unwrapOk(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Alias", alias: ALIAS },
                }),
            );
            expect(registration.slot).toBe(SLOT);
        });

        test("an identity with no entry is null, not the first row's slot", async () => {
            const { chain } = fakeChain({
                registrations: rows({ type: "Account", value: { account_id: OTHER } }),
            });
            const registration = unwrapOk(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(registration.slot).toBeNull();
            expect(registration.entriesScanned).toBe(1);
        });

        test("does not match an alias against an account carrying the same bytes", async () => {
            // The two variants are distinct identities even where the payload
            // collides, so the variant has to be compared as well as the value.
            const { chain } = fakeChain({
                registrations: rows({ type: "Alias", value: { alias: ALIAS } }),
            });
            const registration = unwrapOk(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALIAS },
                }),
            );
            expect(registration.slot).toBeNull();
        });

        test("picks the caller's row out of several", async () => {
            const { chain } = fakeChain({
                registrations: rows(
                    { type: "Account", value: { account_id: ALICE } },
                    { type: "Account", value: { account_id: OTHER } },
                    { type: "Alias", value: { alias: ALIAS } },
                ),
            });
            const registration = unwrapOk(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(registration.slot).toBe(SLOT);
            // Reported so the cost of the scan is visible to the caller.
            expect(registration.entriesScanned).toBe(3);
        });

        test("an empty draw scans nothing and answers null", async () => {
            const { chain } = fakeChain({});
            const registration = unwrapOk(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(registration).toEqual({
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
                eventId: EVENT_ID,
                slot: null,
                entriesScanned: 0,
            });
        });

        test("a transport failure arrives on the err channel", async () => {
            const { chain } = fakeChain({ failOn: "Registrations" });
            const error = unwrapErr(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });

        test("an already-aborted signal costs no round trip", async () => {
            const { chain, calls } = fakeChain({});
            const controller = new AbortController();
            controller.abort();
            const error = unwrapErr(
                await readDrawRegistration(chain, {
                    eventId: EVENT_ID,
                    registrant: { tag: "Account", accountAddress: ALICE },
                    signal: controller.signal,
                }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(calls).toHaveLength(0);
        });
    });
}
