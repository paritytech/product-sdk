// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Signing up for the game, and entering its prize draws in the same call.
 *
 * Two signers: no object satisfies both this package and `submitAndWatch`.
 * `publicKey` must be the key `vrfSigner` binds, or the VRFs verify against
 * nothing.
 *
 * ```ts
 * const vrfSigner = {
 *     signVrf: (label, items) =>
 *         accounts.signVrf(account, label, items).match(
 *             (sig) => sig,
 *             (cause) => {
 *                 throw cause;
 *             },
 *         ),
 * };
 *
 * const req = await readGameSignUpRequirement(chain, { registrant });
 * if (!req.ok || !req.value.canSignUp) return;
 *
 * // A recognized player has canSignUp true and canEnterDraws false, and must
 * // still be signed up.
 * let airdrops;
 * if (req.value.canEnterDraws) {
 *     const vrfs = await mintAccountAirdropVrfs(vrfSigner, {
 *         eventIds: req.value.eventIds,
 *         publicKey: account.publicKey,
 *     });
 *     if (!vrfs.ok) return;
 *     airdrops = vrfs.value;
 * }
 *
 * // Throws on a wrong-width key or a count mismatch.
 * const tx = signUpWithAccountTx(chain, {
 *     identifierKey,
 *     airdrops,
 *     airdropsScheduled: req.value.airdropsScheduled,
 * });
 * await submitAndWatch(tx, txSigner, { waitFor: "finalized" });
 * ```
 *
 * Submission stays with `@parity/product-sdk-tx`, as for `claimPrizeTx`.
 *
 * **The requirement read is not optional.** `eventIds` needs the game index and
 * the draw count from the same block, and the entry count must equal
 * `airdrops_scheduled` exactly or the whole sign-up fails, deposit included.
 *
 * Only the `Account` variant is buildable. `signup-types.ts` says why.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { bytesToHex } from "@parity/product-sdk-utils";
import { gameAirdropEventIds } from "./airdrop-ids.js";
import type { AirdropRegistrant } from "./airdrop-types.js";
import type { FinalizedSnapshot, PersonhoodParticipant } from "./types.js";
import { toPersonhoodParticipant, type RawParticipant } from "./decode.js";
import { ProductIndividualityError } from "./errors.js";
import { runGameRead, type GameChain } from "./game-read.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import { playerKey, type PlayerKey } from "./player-key.js";
import { airdropVrfTranscript, type VrfTranscriptItem } from "./signup-vrf.js";
import type {
    AccountVrfSignature,
    AirdropVrfVariant,
    GameSignUpRequirement,
    SignUpBlocker,
} from "./signup-types.js";

/**
 * Which blockers stop only the draw entry. Exhaustive so a new tag fails to
 * compile until classified, rather than silently blocking the extrinsic.
 */
const DRAW_ONLY = {
    NoGameRunning: false,
    NotInRegistration: false,
    RegistrationEnded: false,
    AlreadyRegistered: false,
    AliasVrfsUnavailable: true,
    AccountVrfsNeedAnAccount: true,
    NoDrawsScheduled: true,
    NotSr25519: true,
} satisfies Record<SignUpBlocker["tag"], boolean>;

/**
 * The chain's `AirdropVrfs`. `Alias` is never constructed, only declared.
 * Exported for `signup-lite.ts`, whose call takes the same argument.
 */
export type AirdropVrfsArg =
    | { type: "Account"; value: { pre_output: string; proof: string }[] }
    | { type: "Alias"; value: { proofs: Uint8Array[]; ring_index: number; revision: number } };

/**
 * The sign-up call, plus the reads that decide what it may carry. Composed with
 * {@link GameChain}, which supplies the game. Matched by hand against the paseo
 * descriptors on 2026-08-21.
 */
export interface SignUpChain<Tx = unknown> extends PinnedChain {
    individuality: {
        constants: { Game: { airdrop_event_id_base(): Promise<string> } };
        query: {
            Game: {
                /** Absent for a player who has never signed up. */
                Players: {
                    getValue: (
                        key: PlayerKey,
                        options: ReadAt,
                    ) => Promise<{ registered: boolean } | undefined>;
                };
            };
            Score: {
                Participants: {
                    getValue: (
                        key: PlayerKey,
                        options: ReadAt,
                    ) => Promise<RawParticipant | undefined>;
                };
            };
        };
        tx: {
            Game: {
                sign_up_with_account(args: {
                    identifier_key: string;
                    /**
                     * Both arms, though only `Account` is built. PAPI `tx` entries
                     * are function-typed properties, so this argument is checked
                     * contravariantly: naming only `Account` is narrower than the
                     * chain's and the real client stops satisfying the interface.
                     */
                    airdrops?: AirdropVrfsArg;
                }): Tx;
            };
        };
    };
}

/** Options for {@link readGameSignUpRequirement}. */
export interface ReadGameSignUpRequirementOptions {
    /** Keys both reads, and must be the identity that will sign. */
    registrant: AirdropRegistrant;
    /**
     * Only `"sr25519"` can mint `Account` VRFs, and no chain read reveals the
     * scheme. Pass it for a `NotSr25519` blocker, omit it and the check is yours.
     */
    keyType?: "sr25519" | "ed25519" | "ecdsa";
    /** Unix **seconds**; defaults to the device clock. */
    now?: number;
    signal?: AbortSignal;
}

/**
 * What this player may do about the running game, at one pinned block. Between
 * games is not a failure, it is a `NoGameRunning` blocker on the success channel.
 */
export async function readGameSignUpRequirement(
    chain: GameChain & SignUpChain,
    options: ReadGameSignUpRequirementOptions,
): Promise<Result<GameSignUpRequirement, ProductIndividualityError>> {
    try {
        return ok((await runSignUpRequirementRead(chain, options)).requirement);
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/**
 * The throwing body of {@link readGameSignUpRequirement}, taking an optional
 * already-pinned snapshot so a composing read shares one block — the same
 * pattern as `runGameRead`. Exported for `readLiteSignUpRequirement`; not part
 * of the package surface.
 */
export async function runSignUpRequirementRead(
    chain: GameChain & SignUpChain,
    options: ReadGameSignUpRequirementOptions,
    pinnedAt?: FinalizedSnapshot,
): Promise<{ requirement: GameSignUpRequirement; player: { registered: boolean } | undefined }> {
    const { registrant, signal } = options;
    const snapshot = await pinBlock(chain, signal, pinnedAt);
    const at = readAt(snapshot, signal);
    const key = playerKey(registrant);

    const [game, rawParticipant, player] = await Promise.all([
        runGameRead(chain, { signal }, snapshot),
        chain.individuality.query.Score.Participants.getValue(key, at),
        chain.individuality.query.Game.Players.getValue(key, at),
    ]);

    // No `Score` record onboards as `NotRecognized`, the same default
    // `validate_register_for_airdrop` takes.
    const recognized =
        rawParticipant !== undefined &&
        isRecognized(toPersonhoodParticipant(rawParticipant).recognition);

    const blockers: SignUpBlocker[] = [];
    if (player?.registered === true) {
        blockers.push({ tag: "AlreadyRegistered" });
    }

    if (game.tag === "BetweenGames") {
        // Only `NoGameRunning`: anything gathered above is about draw entry,
        // and there is no draw here.
        return {
            requirement: {
                at: snapshot,
                gameIndex: null,
                phase: null,
                registrationEnds: null,
                canSignUp: false,
                canEnterDraws: false,
                variant: null,
                airdropsScheduled: 0,
                eventIds: [],
                blockers: [{ tag: "NoGameRunning" }],
            },
            player,
        };
    }

    const { index, phase, registrationEnds, airdropsScheduled } = game.game;
    if (phase !== "Registration") {
        blockers.push({ tag: "NotInRegistration", phase });
    } else if ((options.now ?? Math.floor(Date.now() / 1000)) >= registrationEnds) {
        // The chain checks the clock as well as the state, and the phase moves
        // on an offchain worker's schedule rather than at the deadline.
        blockers.push({ tag: "RegistrationEnded", registrationEnds });
    }

    // What the chain demands, which stays `Account` for an unrecognized person
    // who cannot supply it. The blocker says why not.
    //
    // Every draw-entry blocker lives in this one chain, below the count check,
    // so none of them can name a reason for a draw that does not exist.
    const variant: AirdropVrfVariant = recognized ? "Alias" : "Account";
    if (airdropsScheduled === 0) {
        blockers.push({ tag: "NoDrawsScheduled" });
    } else if (recognized) {
        blockers.push({ tag: "AliasVrfsUnavailable" });
    } else if (registrant.tag === "Alias") {
        blockers.push({ tag: "AccountVrfsNeedAnAccount" });
    } else if (options.keyType !== undefined && options.keyType !== "sr25519") {
        blockers.push({ tag: "NotSr25519", keyType: options.keyType });
    }

    const eventIds =
        airdropsScheduled === 0
            ? []
            : gameAirdropEventIds({
                  base: await chain.individuality.constants.Game.airdrop_event_id_base(),
                  gameIndex: index,
                  airdropsScheduled,
              });

    // This split is what lets a recognized player sign up.
    const canSignUp = blockers.every((blocker) => DRAW_ONLY[blocker.tag]);

    return {
        requirement: {
            at: snapshot,
            gameIndex: index,
            phase,
            registrationEnds,
            canSignUp,
            canEnterDraws: canSignUp && blockers.length === 0,
            variant,
            airdropsScheduled,
            eventIds,
            blockers,
        },
        player,
    };
}

function isRecognized(recognition: PersonhoodParticipant["recognition"]): boolean {
    // `Suspended` is not recognized, which is why this is not a "not
    // NotRecognized" check.
    return recognition === "Recognized" || recognition === "ExternallyRecognized";
}

/**
 * An sr25519 VRF over one draw's transcript.
 *
 * Wire this to `AccountsProvider.signVrf(account, label, items)`. Neither host
 * call satisfies it directly, since both take the account first, so the adapter
 * closes over it and unwraps the `Result`. The module doc has one.
 *
 * Structural, so the package keeps no dependency on `@parity/product-sdk-host`.
 */
export interface AirdropVrfSigner {
    signVrf(transcriptLabel: Uint8Array, items: VrfTranscriptItem[]): Promise<AccountVrfSignature>;
}

/** Options for {@link mintAccountAirdropVrfs}. */
export interface MintAccountAirdropVrfsOptions {
    /** In airdrop-index order: entry `i` is checked against airdrop index `i`. */
    eventIds: string[];
    /** The signing account's sr25519 key, 32 bytes. */
    publicKey: Uint8Array;
    /**
     * Checked between draws only. `AirdropVrfSigner` takes no signal, so a
     * signature already being prompted for cannot be cancelled, unlike the reads.
     */
    signal?: AbortSignal;
}

/**
 * One VRF per scheduled draw, minted through the host.
 *
 * Sequential, not parallel: each is a user-visible signing operation, and firing
 * sixteen at once is hidden by an `AutoSigning` allowance until a product ships
 * without one.
 *
 * No local verification, though one bad entry fails the whole sign-up. Schnorrkel
 * VRF verification does not exist in this workspace, and the failure it guards
 * against is the wrong key, which the transcript binds and the width checks catch.
 */
/**
 * The adapter is caller-written and usually unwraps a `Result`, so resolving with
 * the `Result` itself is a likelier mistake than rejecting. Unchecked it reaches
 * the builder and throws a `TypeError` there, outside any `Result` channel.
 */
function checkSignature(value: AccountVrfSignature): AccountVrfSignature {
    if (!(value?.preOutput instanceof Uint8Array) || !(value?.proof instanceof Uint8Array)) {
        throw new ProductIndividualityError(
            "the VRF signer returned no signature; unwrap the Result before resolving",
        );
    }
    return value;
}

export async function mintAccountAirdropVrfs(
    signer: AirdropVrfSigner,
    options: MintAccountAirdropVrfsOptions,
): Promise<Result<AccountVrfSignature[], ProductIndividualityError>> {
    try {
        const signatures: AccountVrfSignature[] = [];
        for (const eventId of options.eventIds) {
            options.signal?.throwIfAborted();
            const transcript = airdropVrfTranscript({ eventId, publicKey: options.publicKey });
            signatures.push(
                checkSignature(await signer.signVrf(transcript.label, transcript.items)),
            );
        }
        return ok(signatures);
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** Options for {@link signUpWithAccountTx}. */
export interface SignUpWithAccountOptions {
    /**
     * `CommunicationIdentifier`, exactly 65 bytes. Stored against the account and
     * never interpreted by the chain; it is how co-players reach each other.
     */
    identifierKey: Uint8Array;
    /** Omit to enter no draw. Length must equal {@link airdropsScheduled}. */
    airdrops?: AccountVrfSignature[];
    /**
     * From {@link GameSignUpRequirement}, checked against `airdrops` when both are
     * given. A mismatch fails the whole sign-up on chain with the deposit taken,
     * and is reachable by re-reading the requirement between minting and building.
     */
    airdropsScheduled?: number;
}

const IDENTIFIER_KEY_BYTES = 65;
const VRF_PRE_OUTPUT_BYTES = 32;
const VRF_PROOF_BYTES = 64;

/**
 * Build `Game.sign_up_with_account`, unsigned. `Pays::No` on success, though a new
 * or archived player still pays a deposit.
 *
 * No `Alias` argument: a recognized player needs one that cannot be produced, and
 * an argument that always fails on chain is worse than none.
 *
 * @throws ProductIndividualityError on a wrong-width key or signature, or an
 *   airdrop count that disagrees with `airdropsScheduled`. Checked because the
 *   chain's own failure rejects the sign-up with nothing to inspect.
 */
export function signUpWithAccountTx<Tx>(
    chain: SignUpChain<Tx>,
    options: SignUpWithAccountOptions,
): Tx {
    return chain.individuality.tx.Game.sign_up_with_account({
        identifier_key: identifierKeyHex(options.identifierKey),
        airdrops: accountAirdropsArg(options),
    });
}

/**
 * The 65-byte width guard and hex conversion for `identifier_key`, shared with
 * the lite sign-up: both calls store the same `CommunicationIdentifier`.
 * Exported for `signup-lite.ts`; not part of the package surface.
 */
export function identifierKeyHex(identifierKey: Uint8Array): string {
    if (identifierKey.length !== IDENTIFIER_KEY_BYTES) {
        throw new ProductIndividualityError(
            `game sign-up identifier key must be ${IDENTIFIER_KEY_BYTES} bytes`,
        );
    }
    return `0x${bytesToHex(identifierKey)}`;
}

/**
 * The `airdrops` argument both sign-up calls take, with the count and width
 * guards. `undefined` is PAPI's `None`. An empty `Account` list is a different
 * thing, and fails the count check against any game with draws.
 * Exported for `signup-lite.ts`; not part of the package surface.
 */
export function accountAirdropsArg(options: {
    airdrops?: AccountVrfSignature[];
    airdropsScheduled?: number;
}): AirdropVrfsArg | undefined {
    const count = options.airdrops?.length;
    if (
        options.airdropsScheduled !== undefined &&
        count !== undefined &&
        count !== options.airdropsScheduled
    ) {
        throw new ProductIndividualityError(
            `game sign-up needs one airdrop VRF per scheduled draw, got ${count} for ${options.airdropsScheduled}`,
        );
    }
    if (options.airdrops === undefined) {
        return undefined;
    }
    return {
        type: "Account",
        value: options.airdrops.map((signature) => ({
            pre_output: `0x${bytesToHex(
                sizedSignaturePart(signature.preOutput, VRF_PRE_OUTPUT_BYTES, "pre-output"),
            )}`,
            proof: `0x${bytesToHex(sizedSignaturePart(signature.proof, VRF_PROOF_BYTES, "proof"))}`,
        })),
    };
}

function sizedSignaturePart(bytes: Uint8Array, length: number, what: string): Uint8Array {
    if (bytes.length !== length) {
        throw new ProductIndividualityError(`airdrop VRF ${what} must be ${length} bytes`);
    }
    return bytes;
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { unwrapOk, unwrapErr } = await import("@parity/result");

    const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const BASE = "pop:game:airdrop:          ";
    const KEY = new Uint8Array(32).fill(0x11);
    const IDENTIFIER = new Uint8Array(65).fill(0x22);

    const RUNNING_GAME = {
        index: 7,
        registration_ends: 2_000,
        shuffle_deadline: 3_000,
        game_date: 4_000,
        report_ends: 5_000,
        state: { type: "Registration", value: { next_player_index: 0 } },
        max_group_size: 6,
        rounds: 3,
        pending_attendance: 0,
        airdrops_scheduled: 2,
    };

    const DURATIONS = {
        registration: 100,
        shuffle: 100,
        post_shuffle_margin: 100,
        reporting: 100,
        player_process: 100,
    };

    function fakeChain(
        overrides: {
            game?: unknown;
            participant?: unknown;
            player?: unknown;
        } = {},
    ) {
        const calls: { tx: unknown[]; keys: Record<string, unknown> } = { tx: [], keys: {} };
        const chain = {
            raw: {
                individuality: {
                    getFinalizedBlock: async () => ({ hash: `0x${"aa".repeat(32)}`, number: 42 }),
                },
            },
            individuality: {
                constants: {
                    Game: {
                        airdrop_event_id_base: async () => BASE,
                        DefaultPhaseDurations: async () => DURATIONS,
                    },
                },
                query: {
                    Game: {
                        GameIndex: { getValue: async () => 7 },
                        Game: {
                            getValue: async () =>
                                "game" in overrides ? overrides.game : RUNNING_GAME,
                        },
                        GameSchedules: { getValue: async () => [] },
                        StoredPhaseDurations: { getValue: async () => undefined },
                        // Both doubles record the key: `playerKey` is the only
                        // logic here that fails silently, by reading nothing.
                        Players: {
                            getValue: async (key: unknown) => {
                                calls.keys.players = key;
                                return overrides.player;
                            },
                        },
                    },
                    Score: {
                        Participants: {
                            getValue: async (key: unknown) => {
                                calls.keys.participants = key;
                                return overrides.participant;
                            },
                        },
                    },
                },
                tx: {
                    Game: {
                        sign_up_with_account: (args: unknown) => {
                            calls.tx.push(args);
                            return args;
                        },
                    },
                },
            },
        };
        // The structural interfaces are wider than this double in ways the read
        // never touches, which is the point of them being structural.
        return { chain: chain as unknown as GameChain & SignUpChain<unknown>, calls };
    }

    const registrant = { tag: "Account", accountAddress: ACCOUNT } as const;
    const ALIAS = `0x${"dd".repeat(32)}`;
    const RECOGNIZED = {
        score: 10,
        streak: { type: "Attended", value: 1 },
        attendance_history: 1,
        reached_personhood: true,
        recognition: { type: "Recognized", value: `0x${"cc".repeat(32)}` },
        last_attended_game: 6,
    };

    describe("readGameSignUpRequirement", () => {
        test("an unrecognized player in registration can sign up and enter the draws", async () => {
            const { chain } = fakeChain();
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(true);
            expect(value.canEnterDraws).toBe(true);
            expect(value.variant).toBe("Account");
            expect(value.blockers).toEqual([]);
            expect(value.airdropsScheduled).toBe(2);
            expect(value.eventIds).toHaveLength(2);
            // Ids come from the same block's index and count, and differ only in
            // the airdrop-index byte.
            expect(value.eventIds[0]).not.toBe(value.eventIds[1]);
        });

        test("a recognized player may sign up but not enter the draws", async () => {
            // The whole point of splitting sign-up blockers from draw blockers.
            const { chain } = fakeChain({ participant: RECOGNIZED });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 1_000 }),
            );

            expect(value.variant).toBe("Alias");
            expect(value.canSignUp).toBe(true);
            expect(value.canEnterDraws).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AliasVrfsUnavailable" }]);
        });

        test("a suspended player is not recognized, so it stays on the account path", async () => {
            // `is_recognized()` is false for Suspended, so "not NotRecognized" is
            // the wrong test and would send this player to an unbuildable variant.
            const { chain } = fakeChain({
                participant: {
                    score: 1,
                    streak: { type: "Absent", value: 2 },
                    attendance_history: 0,
                    reached_personhood: false,
                    recognition: { type: "Suspended", value: `0x${"cc".repeat(32)}` },
                    last_attended_game: 6,
                },
            });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 1_000 }),
            );

            expect(value.variant).toBe("Account");
            expect(value.canEnterDraws).toBe(true);
        });

        test("between games it reports NoGameRunning rather than failing", async () => {
            const { chain } = fakeChain({ game: undefined });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.gameIndex).toBeNull();
            expect(value.eventIds).toEqual([]);
            expect(value.blockers).toEqual([{ tag: "NoGameRunning" }]);
        });

        test("a deadline that has passed inside the registration phase still blocks", async () => {
            // The offchain worker moves the phase in its own time, so the clock and
            // the state disagree here, and the chain checks both.
            const { chain } = fakeChain();
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 2_001 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.blockers).toEqual([{ tag: "RegistrationEnded", registrationEnds: 2_000 }]);
        });

        test("an already-registered player is blocked from signing up again", async () => {
            const { chain } = fakeChain({ player: { registered: true } });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AlreadyRegistered" }]);
        });

        test("keys both reads by AccountOrPerson, spelling the alias arm Person", async () => {
            // Both entries take the same key, and the airdrop registration entry
            // spells this arm `Alias`.
            const account = fakeChain();
            await readGameSignUpRequirement(account.chain, { registrant, now: 1_000 });
            expect(account.calls.keys.players).toEqual({ type: "Account", value: ACCOUNT });
            expect(account.calls.keys.participants).toEqual({ type: "Account", value: ACCOUNT });

            const alias = fakeChain();
            await readGameSignUpRequirement(alias.chain, {
                registrant: { tag: "Alias", alias: ALIAS },
                now: 1_000,
            });
            expect(alias.calls.keys.players).toEqual({ type: "Person", value: ALIAS });
            expect(alias.calls.keys.participants).toEqual({ type: "Person", value: ALIAS });
        });

        test("an unrecognized person cannot enter the draws with either variant", async () => {
            // The chain rejects the whole sign-up here, and the fee is paid.
            const { chain } = fakeChain();
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, {
                    registrant: { tag: "Alias", alias: ALIAS },
                    now: 1_000,
                }),
            );

            expect(value.variant).toBe("Account");
            expect(value.canSignUp).toBe(true);
            expect(value.canEnterDraws).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AccountVrfsNeedAnAccount" }]);
        });

        test("a recognized person still reports the alias blocker, not the origin one", async () => {
            const { chain } = fakeChain({ participant: RECOGNIZED });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, {
                    registrant: { tag: "Alias", alias: ALIAS },
                    now: 1_000,
                }),
            );

            expect(value.blockers).toEqual([{ tag: "AliasVrfsUnavailable" }]);
        });

        test("a game with no draws says so, whatever the recognition", async () => {
            // The truthful cause: there is nothing to enter, whatever the variant.
            for (const participant of [undefined, RECOGNIZED]) {
                const { chain } = fakeChain({
                    game: { ...RUNNING_GAME, airdrops_scheduled: 0 },
                    participant,
                });
                const value = unwrapOk(
                    await readGameSignUpRequirement(chain, { registrant, now: 1_000 }),
                );

                expect(value.blockers).toEqual([{ tag: "NoDrawsScheduled" }]);
                expect(value.canSignUp).toBe(true);
                expect(value.eventIds).toEqual([]);
            }
        });

        test("between games reports only NoGameRunning", async () => {
            // Draw-entry blockers name nothing actionable with no game.
            const { chain } = fakeChain({ game: undefined });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, {
                    registrant,
                    keyType: "ed25519",
                    now: 1_000,
                }),
            );

            expect(value.blockers).toEqual([{ tag: "NoGameRunning" }]);
        });

        test("a game with no draws does not also blame the key", async () => {
            // The key blocker used to sit above the game read, so it named a
            // reason for draws that were never scheduled.
            const { chain } = fakeChain({ game: { ...RUNNING_GAME, airdrops_scheduled: 0 } });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, {
                    registrant,
                    keyType: "ed25519",
                    now: 1_000,
                }),
            );

            expect(value.blockers).toEqual([{ tag: "NoDrawsScheduled" }]);
        });

        test("a known non-sr25519 key blocks the draws, not the sign-up", async () => {
            const { chain } = fakeChain();
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, {
                    registrant,
                    keyType: "ed25519",
                    now: 1_000,
                }),
            );

            expect(value.canSignUp).toBe(true);
            expect(value.canEnterDraws).toBe(false);
            expect(value.blockers).toEqual([{ tag: "NotSr25519", keyType: "ed25519" }]);
        });
    });

    describe("mintAccountAirdropVrfs", () => {
        test("signs once per event, in order, with the same key", async () => {
            const seen: Uint8Array[] = [];
            const signer: AirdropVrfSigner = {
                signVrf: async (_label, items) => {
                    seen.push(items[0].value);
                    return { preOutput: new Uint8Array(32), proof: new Uint8Array(64) };
                },
            };

            const ids = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`];
            const result = await mintAccountAirdropVrfs(signer, { eventIds: ids, publicKey: KEY });

            expect(unwrapOk(result)).toHaveLength(2);
            // Each transcript's domain carries its own event id, which is the
            // binding that stops one entry standing in for another.
            expect(seen).toHaveLength(2);
            expect(seen[0]).not.toEqual(seen[1]);
        });

        test("a host rejection becomes an error, not a short list", async () => {
            // A partial list would be submitted and fail the count check on chain,
            // costing the deposit for a failure that was already known here.
            const signer: AirdropVrfSigner = {
                signVrf: vi
                    .fn()
                    .mockResolvedValueOnce({
                        preOutput: new Uint8Array(32),
                        proof: new Uint8Array(64),
                    })
                    .mockRejectedValueOnce(new Error("host rejected")),
            };

            const result = await mintAccountAirdropVrfs(signer, {
                eventIds: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`],
                publicKey: KEY,
            });

            expect(unwrapErr(result)).toBeInstanceOf(ProductIndividualityError);
        });
    });

    describe("signUpWithAccountTx", () => {
        test("omits airdrops entirely when none are given", async () => {
            const { chain, calls } = fakeChain();
            signUpWithAccountTx(chain, { identifierKey: IDENTIFIER });

            expect(calls.tx[0]).toEqual({
                identifier_key: `0x${"22".repeat(65)}`,
                airdrops: undefined,
            });
        });

        test("wraps the signatures in the Account variant, hex-encoded", () => {
            const { chain, calls } = fakeChain();
            signUpWithAccountTx(chain, {
                identifierKey: IDENTIFIER,
                airdrops: [
                    {
                        preOutput: new Uint8Array(32).fill(0xaa),
                        proof: new Uint8Array(64).fill(0xbb),
                    },
                ],
            });

            expect(calls.tx[0]).toEqual({
                identifier_key: `0x${"22".repeat(65)}`,
                airdrops: {
                    type: "Account",
                    value: [{ pre_output: `0x${"aa".repeat(32)}`, proof: `0x${"bb".repeat(64)}` }],
                },
            });
        });

        test("an empty list is not the same as none", () => {
            // `Some([])` fails the count check against any game with draws, where
            // `None` is always valid. Keeping them distinct is deliberate.
            const { chain, calls } = fakeChain();
            signUpWithAccountTx(chain, { identifierKey: IDENTIFIER, airdrops: [] });

            expect(calls.tx[0]).toEqual({
                identifier_key: `0x${"22".repeat(65)}`,
                airdrops: { type: "Account", value: [] },
            });
        });

        test("rejects an airdrop count that disagrees with the schedule", () => {
            // Both sides optional, so only a stated disagreement throws.
            const { chain } = fakeChain();
            const one = [{ preOutput: new Uint8Array(32), proof: new Uint8Array(64) }];

            expect(() =>
                signUpWithAccountTx(chain, {
                    identifierKey: IDENTIFIER,
                    airdrops: one,
                    airdropsScheduled: 2,
                }),
            ).toThrow(ProductIndividualityError);

            expect(() =>
                signUpWithAccountTx(chain, {
                    identifierKey: IDENTIFIER,
                    airdrops: one,
                    airdropsScheduled: 1,
                }),
            ).not.toThrow();
            expect(() =>
                signUpWithAccountTx(chain, { identifierKey: IDENTIFIER, airdrops: one }),
            ).not.toThrow();
            expect(() =>
                signUpWithAccountTx(chain, { identifierKey: IDENTIFIER, airdropsScheduled: 2 }),
            ).not.toThrow();
        });

        test("rejects a wrong-width identifier key and signature", () => {
            const { chain } = fakeChain();
            expect(() => signUpWithAccountTx(chain, { identifierKey: new Uint8Array(64) })).toThrow(
                ProductIndividualityError,
            );
            expect(() =>
                signUpWithAccountTx(chain, {
                    identifierKey: IDENTIFIER,
                    airdrops: [{ preOutput: new Uint8Array(31), proof: new Uint8Array(64) }],
                }),
            ).toThrow(ProductIndividualityError);
        });
    });
}
