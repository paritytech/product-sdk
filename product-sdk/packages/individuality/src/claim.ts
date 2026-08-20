// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Claiming a prize: check it, build the call, confirm it landed.
 *
 * **Submission is not here.** `claimPrizeTx` returns a PAPI transaction, so
 * signing and watching stay with `@parity/product-sdk-tx` — the same split
 * `withAsPerson` uses, and retries, batching and fee estimation come free of it.
 *
 * ```ts
 * const tx = claimPrizeTx(chain, { gameIndex, airdropIndex, beneficiary });
 * await submitAndWatch(tx, signer, { waitFor: "finalized" });
 * ```
 *
 * The call is identical under a person origin — `claim_airdrop` accepts both and
 * derives the registration entry from whichever it got — so wrap the signer with
 * `withAsPerson` and change nothing else.
 *
 * **Persist the ticket when you claim.** Once the row is gone it is the only local
 * evidence separating "claimed" from "never won" ({@link confirmClaim}).
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { runDrawRead, type AirdropChain } from "./airdrop-read.js";
import { gameAirdropEventId } from "./airdrop-ids.js";
import type { AirdropRegistrant } from "./airdrop-types.js";
import { deriveClaimEligibility } from "./claim-derive.js";
import type { ClaimEligibilityResult, ClaimOutcome } from "./claim-types.js";
import { toRawRegistrationEntry } from "./airdrop-decode.js";
import { toPersonhoodParticipant, type RawParticipant } from "./decode.js";
import { ProductIndividualityError } from "./errors.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import type { PersonhoodParticipant } from "./types.js";

/**
 * The `Game.claim_airdrop` call, plus the `Score.Participants` read the check
 * needs. Composed with `AirdropChain`, which supplies the draw.
 */
export interface ClaimChain extends PinnedChain {
    individuality: {
        constants: { Game: { airdrop_event_id_base(): Promise<string> } };
        query: {
            Score: {
                Participants: {
                    getValue(
                        key: { type: string; value: unknown },
                        options: ReadAt,
                    ): Promise<RawParticipant | undefined>;
                };
            };
        };
        tx: {
            Game: {
                claim_airdrop(args: {
                    game_index: number;
                    airdrop_index: number;
                    beneficiary: string;
                }): unknown;
            };
        };
    };
}

/** Everything a claim addresses. */
export interface ClaimTarget {
    gameIndex: number;
    airdropIndex: number;
    /**
     * Who is claiming. Decides both the `Score.Participants` key and the
     * `Winners` key, and must match the identity that entered the draw — a
     * player who signed up with an alias cannot claim as an account.
     */
    registrant: AirdropRegistrant;
}

/** Options for {@link readClaimEligibility}. */
export interface ReadClaimEligibilityOptions extends ClaimTarget {
    /** Unix **seconds**; defaults to the device clock. See {@link ClaimInputs.now}. */
    now?: number;
    signal?: AbortSignal;
}

/** The `Score.Participants` key for a registrant. */
function participantKey(registrant: AirdropRegistrant): { type: string; value: unknown } {
    // `AccountOrPerson` names the account variant `Account` and the alias one
    // `Person`, where `Airdrop`'s registration entry calls the second `Alias`.
    // Same identity, two spellings, and the wrong one silently reads nothing.
    return registrant.tag === "Account"
        ? { type: "Account", value: registrant.accountAddress }
        : { type: "Person", value: registrant.alias };
}

/**
 * Check whether one prize can be claimed, from one pinned finalized block — the
 * five gates span the draw and the score record, so reading them apart is exactly
 * the inconsistency pinning prevents.
 */
export async function readClaimEligibility(
    chain: AirdropChain & ClaimChain,
    options: ReadClaimEligibilityOptions,
): Promise<Result<ClaimEligibilityResult, ProductIndividualityError>> {
    try {
        const { gameIndex, airdropIndex, registrant, signal } = options;
        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);

        const base = await chain.individuality.constants.Game.airdrop_event_id_base();
        const eventId = gameAirdropEventId({ base, gameIndex, airdropIndex });

        const [draw, rawParticipant] = await Promise.all([
            runDrawRead(chain, { eventId, registrant, signal }, snapshot),
            chain.individuality.query.Score.Participants.getValue(participantKey(registrant), at),
        ]);

        const participant: PersonhoodParticipant | null =
            rawParticipant === undefined ? null : toPersonhoodParticipant(rawParticipant);

        return ok({
            at: snapshot,
            gameIndex,
            airdropIndex,
            eventId,
            ...deriveClaimEligibility({
                gameIndex,
                draw,
                participant,
                // Seconds, not milliseconds: every timestamp on these two pallets
                // is a Unix second.
                now: options.now ?? Math.floor(Date.now() / 1000),
            }),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/**
 * Build the `Game.claim_airdrop` call, unsigned. `Pays::No` on success, so only a
 * rejected claim costs a fee.
 *
 * @param options.beneficiary - need not be the claimant; the chain takes any
 *   account, which is what gives an alias claimant somewhere to be paid.
 */
export function claimPrizeTx<T = unknown>(
    chain: ClaimChain,
    options: { gameIndex: number; airdropIndex: number; beneficiary: string },
): T {
    return chain.individuality.tx.Game.claim_airdrop({
        game_index: options.gameIndex,
        airdrop_index: options.airdropIndex,
        beneficiary: options.beneficiary,
    }) as T;
}

/** Options for {@link confirmClaim}. */
export interface ConfirmClaimOptions extends ClaimTarget {
    signal?: AbortSignal;
}

/**
 * Did a submitted claim take effect? Re-reads the row rather than watching, so it
 * answers after a reload. Absence means it landed — *unless* the draw has left
 * `Claiming`, where the lifecycle may have swept the row instead.
 */
export async function confirmClaim(
    chain: AirdropChain & ClaimChain,
    options: ConfirmClaimOptions,
): Promise<Result<ClaimOutcome, ProductIndividualityError>> {
    try {
        const { gameIndex, airdropIndex, registrant, signal } = options;
        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);

        const base = await chain.individuality.constants.Game.airdrop_event_id_base();
        const eventId = gameAirdropEventId({ base, gameIndex, airdropIndex });

        const [ticket, rawEvent] = await Promise.all([
            chain.individuality.query.Airdrop.Winners.getValue(
                eventId,
                toRawRegistrationEntry(registrant),
                at,
            ),
            chain.individuality.query.Airdrop.Events.getValue(eventId, at),
        ]);

        if (ticket !== undefined) {
            return ok({ tag: "Pending", at: snapshot, ticket });
        }

        // No ticket. Only a draw still taking claims makes that unambiguous —
        // `ClearingWinners` drains the same rows, and a finalized draw has none.
        const phase = rawEvent?.status.type;
        return ok(
            phase === "Claiming"
                ? { tag: "Claimed", at: snapshot }
                : {
                      tag: "Unknown",
                      at: snapshot,
                      phase: phase === undefined ? "Gone" : "Settling",
                  },
        );
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapOk, unwrapErr } = await import("@parity/result");
    const { GAME_AIRDROP_EVENT_ID_BASE, gameAirdropEventId: eventIdOf } = await import(
        "./airdrop-ids.js"
    );

    const BLOCK = { hash: `0x${"88".repeat(32)}`, number: 5_150 };
    const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const ALIAS = `0x${"ab".repeat(32)}`;
    const TICKET = `0x${"ee".repeat(32)}`;
    const END = 1_800_000_000;
    const EVENT_ID = eventIdOf({
        base: GAME_AIRDROP_EVENT_ID_BASE,
        gameIndex: 41,
        airdropIndex: 0,
    });

    const rawParticipant = (overrides: Partial<RawParticipant> = {}): RawParticipant => ({
        score: 10,
        streak: { type: "Attended", value: 3 },
        attendance_history: 0xff,
        reached_personhood: true,
        recognition: { type: "Recognized", value: 1n },
        last_attended_game: 41,
        ...overrides,
    });

    interface FakeState {
        participant?: RawParticipant;
        ticket?: string;
        status?: string;
        eventMissing?: boolean;
    }

    /** Records the keys every read was addressed with, and the built call. */
    function fakeChain(state: FakeState) {
        const keys: Array<{ entry: string; key: unknown }> = [];
        let built: unknown = null;
        const chain = {
            individuality: {
                constants: {
                    Game: { airdrop_event_id_base: async () => GAME_AIRDROP_EVENT_ID_BASE },
                },
                query: {
                    Score: {
                        Participants: {
                            getValue: async (key: unknown) => {
                                keys.push({ entry: "Participants", key });
                                return state.participant;
                            },
                        },
                    },
                    Airdrop: {
                        Events: {
                            getValue: async (id: string) => {
                                keys.push({ entry: "Events", key: id });
                                return state.eventMissing
                                    ? undefined
                                    : {
                                          id,
                                          info: {
                                              prize: {
                                                  asset_id: {
                                                      parents: 1,
                                                      interior: { type: "Here", value: undefined },
                                                  },
                                                  asset_amount: 100n,
                                                  max_winners: 5,
                                                  winner_cap: 10_000,
                                              },
                                              registration_starts: BigInt(END - 86_400),
                                              draw_time: BigInt(END - 7_200),
                                              end_time: BigInt(END),
                                          },
                                          status: {
                                              type: state.status ?? "Claiming",
                                              value: {
                                                  total_participants: 9,
                                                  effective_winners: 2,
                                                  claimed: 0,
                                              },
                                          },
                                      };
                            },
                        },
                        Winners: {
                            getValue: async (id: string, entry: unknown) => {
                                keys.push({ entry: "Winners", key: [id, entry] });
                                return state.ticket;
                            },
                        },
                        EventEntropy: { getValue: async () => undefined },
                        Registrations: { getEntries: async () => [] },
                    },
                },
                tx: {
                    Game: {
                        claim_airdrop: (args: unknown) => {
                            built = args;
                            return { call: "Game.claim_airdrop", args };
                        },
                    },
                },
            },
            raw: { individuality: { getFinalizedBlock: async () => BLOCK } },
        } as unknown as AirdropChain & ClaimChain;
        return { chain, keys: () => keys, built: () => built };
    }

    describe("readClaimEligibility", () => {
        test("a recognized winner inside the window is claimable", async () => {
            const { chain } = fakeChain({ participant: rawParticipant(), ticket: TICKET });
            const result = unwrapOk(
                await readClaimEligibility(chain, {
                    gameIndex: 41,
                    airdropIndex: 0,
                    registrant: { tag: "Account", accountAddress: ALICE },
                    now: END - 60,
                }),
            );

            expect(result.claimable).toBe(true);
            expect(result.ticket).toBe(TICKET);
            expect(result.eventId).toBe(EVENT_ID);
            expect(result.at).toEqual({ blockHash: BLOCK.hash, blockNumber: BLOCK.number });
        });

        test("keys the score read by Account for an account registrant", async () => {
            const { chain, keys } = fakeChain({ participant: rawParticipant(), ticket: TICKET });
            await readClaimEligibility(chain, {
                gameIndex: 41,
                airdropIndex: 0,
                registrant: { tag: "Account", accountAddress: ALICE },
                now: END - 60,
            });
            expect(keys().find((k) => k.entry === "Participants")?.key).toEqual({
                type: "Account",
                value: ALICE,
            });
        });

        test("keys the score read by Person for an alias registrant", async () => {
            // `AccountOrPerson` spells the alias variant `Person` while the
            // airdrop entry spells it `Alias`. Reading with the wrong spelling
            // finds nothing and looks like a missing record.
            const { chain, keys } = fakeChain({ participant: rawParticipant(), ticket: TICKET });
            await readClaimEligibility(chain, {
                gameIndex: 41,
                airdropIndex: 0,
                registrant: { tag: "Alias", alias: ALIAS },
                now: END - 60,
            });
            expect(keys().find((k) => k.entry === "Participants")?.key).toEqual({
                type: "Person",
                value: ALIAS,
            });
            expect(keys().find((k) => k.entry === "Winners")?.key).toEqual([
                EVENT_ID,
                { type: "Alias", value: { alias: ALIAS } },
            ]);
        });

        test("no score record blocks the claim", async () => {
            const { chain } = fakeChain({ ticket: TICKET });
            const result = unwrapOk(
                await readClaimEligibility(chain, {
                    gameIndex: 41,
                    airdropIndex: 0,
                    registrant: { tag: "Account", accountAddress: ALICE },
                    now: END - 60,
                }),
            );
            expect(result.claimable).toBe(false);
            expect(result.blockers).toEqual([{ tag: "NotAParticipant" }]);
        });

        test("a claimed or unwon prize blocks with NoPrize", async () => {
            const { chain } = fakeChain({ participant: rawParticipant() });
            const result = unwrapOk(
                await readClaimEligibility(chain, {
                    gameIndex: 41,
                    airdropIndex: 0,
                    registrant: { tag: "Account", accountAddress: ALICE },
                    now: END - 60,
                }),
            );
            expect(result.blockers).toEqual([{ tag: "NoPrize" }]);
        });

        test("defaults `now` to the device clock", async () => {
            // The draw's end_time is in 2027, so the default must be treated as
            // inside the window rather than ignored.
            const { chain } = fakeChain({ participant: rawParticipant(), ticket: TICKET });
            const result = unwrapOk(
                await readClaimEligibility(chain, {
                    gameIndex: 41,
                    airdropIndex: 0,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(result.blockers.some((b) => b.tag === "ClaimWindowClosed")).toBe(false);
        });

        test("a transport failure arrives on the err channel", async () => {
            const { chain } = fakeChain({});
            const broken = {
                ...chain,
                raw: {
                    individuality: {
                        getFinalizedBlock: async () => {
                            throw new Error("node down");
                        },
                    },
                },
            } as AirdropChain & ClaimChain;
            const error = unwrapErr(
                await readClaimEligibility(broken, {
                    gameIndex: 41,
                    airdropIndex: 0,
                    registrant: { tag: "Account", accountAddress: ALICE },
                }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
        });
    });

    describe("claimPrizeTx", () => {
        test("builds the call with the chain's own argument names", async () => {
            // snake_case, and the beneficiary is an SS58 string. PAPI encodes
            // whatever it is given, so a renamed field would encode as undefined.
            const { chain, built } = fakeChain({});
            claimPrizeTx(chain, { gameIndex: 41, airdropIndex: 2, beneficiary: ALICE });
            expect(built()).toEqual({
                game_index: 41,
                airdrop_index: 2,
                beneficiary: ALICE,
            });
        });

        test("returns whatever the chain's tx builder returned", async () => {
            const { chain } = fakeChain({});
            expect(
                claimPrizeTx<{ call: string }>(chain, {
                    gameIndex: 1,
                    airdropIndex: 0,
                    beneficiary: ALICE,
                }).call,
            ).toBe("Game.claim_airdrop");
        });
    });

    describe("confirmClaim", () => {
        const target = {
            gameIndex: 41,
            airdropIndex: 0,
            registrant: { tag: "Account", accountAddress: ALICE },
        } as const;

        test("a ticket still present means the claim has not landed", async () => {
            const { chain } = fakeChain({ ticket: TICKET });
            const outcome = unwrapOk(await confirmClaim(chain, target));
            expect(outcome).toEqual({ tag: "Pending", at: expect.anything(), ticket: TICKET });
        });

        test("the ticket gone while still Claiming means it landed", async () => {
            // The whole resume story: a successful claim removes the row, so its
            // absence is the confirmation.
            const { chain } = fakeChain({});
            const outcome = unwrapOk(await confirmClaim(chain, target));
            expect(outcome.tag).toBe("Claimed");
        });

        test("the ticket gone after Claiming is Unknown, not Claimed", async () => {
            // `ClearingWinners` drains the same rows, so absence no longer proves
            // a claim.
            const { chain } = fakeChain({ status: "ClearingWinners" });
            const outcome = unwrapOk(await confirmClaim(chain, target));
            expect(outcome).toEqual({
                tag: "Unknown",
                at: expect.anything(),
                phase: "Settling",
            });
        });

        test("a vanished event is Unknown with phase Gone", async () => {
            const { chain } = fakeChain({ eventMissing: true });
            const outcome = unwrapOk(await confirmClaim(chain, target));
            expect(outcome).toEqual({ tag: "Unknown", at: expect.anything(), phase: "Gone" });
        });

        test("addresses the winner lookup with the derived event id", async () => {
            const { chain, keys } = fakeChain({ ticket: TICKET });
            await confirmClaim(chain, target);
            expect(keys().find((k) => k.entry === "Winners")?.key).toEqual([
                EVENT_ID,
                { type: "Account", value: { account_id: ALICE } },
            ]);
        });
    });
}
