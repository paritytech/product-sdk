// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Full-personhood registration — the step after the score is in.
 *
 * `Score.register(Some((member_key, proof_of_ownership)))` turns a participant
 * whose score reached `Score.PersonhoodThreshold` into a person in the *people*
 * ring: the runtime reserves a personal id, queues the member key, and moves
 * `Score.Participants[Account]` to `Recognized(id)`. The call is made by the
 * **participant account** — `register` reads `Participants[Account(signer)]`
 * and nothing else identifies the caller — so it rides an ordinary signed
 * origin, or the fee-free `ScoreAsParticipant` extension
 * (`as-score-participant-signer.ts`), which itself requires a `Signed` origin
 * underneath.
 *
 * The `(member_key, proof_of_ownership)` pair is opaque to this package on
 * purpose. Producing it takes the personhood product's own host session —
 * `registerRingVrfKey(Index(0), peopleRing)` for the 32-byte key,
 * `ringVrfSign` over {@link registerMessage} for the 64-byte plain Bandersnatch
 * signature — and today's hosts refuse both calls to any other product. So the
 * builder takes the pair as caller-supplied bytes and never tries to mint it,
 * which is also what lets the same builder serve a two-product handoff and a
 * future single-product path unchanged.
 *
 * {@link registerMessage} is the one byte-exact contract: the pallet does
 * `account.using_encoded(|b| [PREFIX, b].concat())`, and `AccountId32` encodes
 * as its bare 32 bytes — a *raw* concatenation, not SCALE, 50 bytes total
 * (individuality `pallets/score/src/lib.rs`, `register`). A signature over
 * anything else fails on chain as `InvalidProofOfOwnership`. Verified live on
 * previewnet (spec 1000036, individuality v0.12.1) on 2026-08-28.
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import {
 *     readRegistrationEligibility,
 *     registerPersonhoodTx,
 *     withScoreParticipant,
 * } from "@parity/product-sdk-individuality";
 *
 * const eligibility = await readRegistrationEligibility(chain, { registrant });
 * if (eligibility.ok && eligibility.value.readyToRegister) {
 *     // (memberKey, proofOfOwnership) come from the personhood product's host
 *     // session, signing registerMessage(account) with the full member key.
 *     const tx = registerPersonhoodTx(chain, { memberKey, proofOfOwnership });
 *     await submitAndWatch(tx, withScoreParticipant(signer));
 * }
 * ```
 *
 * Only the key-carrying arm is buildable here. A `Suspended` participant
 * resumes with `register(None)` — a different call shape with different
 * guards — and {@link readRegistrationEligibility} reports such a participant
 * as not ready rather than offering a call that would fail.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { AccountId, type SS58String } from "polkadot-api";
import { bytesToHex, utf8ToBytes } from "@parity/product-sdk-utils";
import { toPersonhoodParticipant, type RawParticipant } from "./decode.js";
import { ProductIndividualityError } from "./errors.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import { playerKey, type PlayerKey } from "./player-key.js";
import type { AirdropRegistrant } from "./airdrop-types.js";
import type { FinalizedSnapshot, PersonhoodParticipant } from "./types.js";

/**
 * The pallet's domain prefix for the proof of ownership in `Score.register`.
 * 18 bytes of UTF-8, concatenated raw — no separator, no length prefix.
 */
export const REGISTER_MESSAGE_PREFIX = "pop register using";

/** `AccountId32`: the account id width the message embeds. */
const ACCOUNT_BYTES = 32;

/** The full member key is a 32-byte Bandersnatch public key. */
const MEMBER_KEY_BYTES = 32;

/** The proof of ownership is a 64-byte plain (non-ring) Bandersnatch signature. */
const PROOF_OF_OWNERSHIP_BYTES = 64;

/**
 * `"pop register using" ++ account` — the 50 bytes the full member key signs.
 *
 * The pallet builds the same bytes with
 * `account.using_encoded(|b| [PREFIX, b].concat())`, and `AccountId32` encodes
 * as its bare 32 bytes, so this is a raw concatenation with no SCALE framing.
 *
 * @param account - the registering account (the transaction signer), as an
 *   SS58 address or its raw 32-byte public key.
 * @throws ProductIndividualityError when the account does not decode or is not 32 bytes.
 */
export function registerMessage(account: SS58String | Uint8Array): Uint8Array {
    let bytes: Uint8Array;
    if (typeof account === "string") {
        try {
            bytes = AccountId().enc(account);
        } catch (cause) {
            throw new ProductIndividualityError("register message account is not a valid address", {
                cause,
            });
        }
    } else {
        bytes = account;
    }
    if (bytes.length !== ACCOUNT_BYTES) {
        throw new ProductIndividualityError(
            `register message account must be ${ACCOUNT_BYTES} bytes`,
        );
    }
    const prefix = utf8ToBytes(REGISTER_MESSAGE_PREFIX);
    const message = new Uint8Array(prefix.length + bytes.length);
    message.set(prefix);
    message.set(bytes, prefix.length);
    return message;
}

/**
 * The `Score.register` call, typed structurally so the package needs no
 * descriptor dependency. Matched by hand against the previewnet descriptors on
 * 2026-08-31:
 *
 * ```
 * Score.register: TxDescriptor<{ key?: [SizedHex<32>, SizedHex<64>] }>
 * ```
 */
export interface RegisterChain<Tx = unknown> {
    individuality: {
        tx: {
            Score: {
                register(args: {
                    /**
                     * `Some((member_key, proof_of_ownership))` as `0x` hex, or
                     * absent for the resume arm this package does not build.
                     */
                    key?: [string, string];
                }): Tx;
            };
        };
    };
}

/** Options for {@link registerPersonhoodTx}. */
export interface RegisterPersonhoodOptions {
    /**
     * The full member key, 32 bytes: `registerRingVrfKey(Index(0), peopleRing)`
     * from the personhood product's host session. Opaque here — this package
     * never mints it.
     */
    memberKey: Uint8Array;
    /**
     * A plain Bandersnatch signature by that key over
     * `registerMessage(account)`, 64 bytes: `ringVrfSign` from the same
     * session. `account` must be the account that will sign the transaction,
     * or the chain answers `InvalidProofOfOwnership`.
     */
    proofOfOwnership: Uint8Array;
}

/**
 * Build `Score.register(Some((member_key, proof_of_ownership)))`, unsigned.
 * `Pays::No` on success. Submission stays with `@parity/product-sdk-tx`, and
 * the fee-free origin with {@link import("./as-score-participant-signer.js").withScoreParticipant}.
 *
 * Preconditions on chain, or the dispatch fails: `Score.Participants` has the
 * signer with `reached_personhood || score >= PersonhoodThreshold` and
 * `recognition == NotRecognized` — check with {@link readRegistrationEligibility}.
 * `InvalidProofOfOwnership` means the message or key is wrong; `KeyAlreadyInUse`
 * that this member key already is a person.
 *
 * @throws ProductIndividualityError on a wrong-width key or signature. Checked
 *   here because the chain's own failure rejects the call with nothing to
 *   inspect, after the fee-free allowance was already spent on it.
 */
export function registerPersonhoodTx<Tx>(
    chain: RegisterChain<Tx>,
    options: RegisterPersonhoodOptions,
): Tx {
    if (options.memberKey.length !== MEMBER_KEY_BYTES) {
        throw new ProductIndividualityError(`member key must be ${MEMBER_KEY_BYTES} bytes`);
    }
    if (options.proofOfOwnership.length !== PROOF_OF_OWNERSHIP_BYTES) {
        throw new ProductIndividualityError(
            `proof of ownership must be ${PROOF_OF_OWNERSHIP_BYTES} bytes`,
        );
    }
    return chain.individuality.tx.Score.register({
        key: [`0x${bytesToHex(options.memberKey)}`, `0x${bytesToHex(options.proofOfOwnership)}`],
    });
}

/**
 * The two reads {@link readRegistrationEligibility} folds. Matched by hand
 * against the previewnet descriptors on 2026-08-31:
 *
 * ```
 * Score.Participants:        StorageDescriptor<[Key: AccountOrPerson], Participant, true, never>
 * Score.PersonhoodThreshold: StorageDescriptor<[], number, false, never>
 * ```
 *
 * `PersonhoodThreshold` is a storage item, not a constant: the runtime
 * recalculates it from a population-tiered schedule at the start of each report
 * session, so it can move under a participant mid-season — which is why both
 * reads are pinned to one block.
 */
export interface RegistrationEligibilityChain extends PinnedChain {
    individuality: {
        query: {
            Score: {
                Participants: {
                    /** Property syntax on purpose; see `player-key.ts`. */
                    getValue: (
                        key: PlayerKey,
                        options: ReadAt,
                    ) => Promise<RawParticipant | undefined>;
                };
                PersonhoodThreshold: {
                    getValue(options: ReadAt): Promise<number>;
                };
            };
        };
    };
}

/** Options for {@link readRegistrationEligibility}. */
export interface ReadRegistrationEligibilityOptions {
    /** The account that would sign `register`; the pallet reads no other key. */
    registrant: Extract<AirdropRegistrant, { tag: "Account" }>;
    signal?: AbortSignal;
}

/**
 * A participant's standing against the registration guards, at one pinned
 * block.
 */
export interface RegistrationEligibility {
    at: FinalizedSnapshot;
    /** `null` for an account `Score` has never seen. */
    participant: PersonhoodParticipant | null;
    /** `Score.PersonhoodThreshold` at the same block. A `u8` on chain. */
    personhoodThreshold: number;
    /** {@link readyToRegister} over the two fields above. */
    readyToRegister: boolean;
}

/**
 * Whether `Score.register` with a key would pass its guards now: the
 * participant exists, is `NotRecognized`, and has the score or the sticky
 * `reached_personhood` flag.
 *
 * `Suspended` participants are *not* ready in this sense — they resume with
 * `register(None)`, a different call shape this package does not build — and
 * neither are already-recognized ones.
 *
 * Exported separately from the read, so it can run against a participant the
 * caller already holds.
 */
export function readyToRegister(
    participant: PersonhoodParticipant | null,
    personhoodThreshold: number,
): boolean {
    if (participant === null || participant.recognition !== "NotRecognized") {
        return false;
    }
    return participant.reachedPersonhood || participant.score >= personhoodThreshold;
}

/**
 * Read `Score.Participants` and `Score.PersonhoodThreshold` at one pinned block
 * and fold them into {@link RegistrationEligibility}.
 *
 * **Not an authorization oracle.** The chain re-checks every guard at dispatch,
 * and the threshold can move between this read and the transaction landing.
 */
export async function readRegistrationEligibility(
    chain: RegistrationEligibilityChain,
    options: ReadRegistrationEligibilityOptions,
): Promise<Result<RegistrationEligibility, ProductIndividualityError>> {
    try {
        const snapshot = await pinBlock(chain, options.signal);
        const at = readAt(snapshot, options.signal);

        const [rawParticipant, personhoodThreshold] = await Promise.all([
            chain.individuality.query.Score.Participants.getValue(
                playerKey(options.registrant),
                at,
            ),
            chain.individuality.query.Score.PersonhoodThreshold.getValue(at),
        ]);

        const participant =
            rawParticipant === undefined ? null : toPersonhoodParticipant(rawParticipant);

        return ok({
            at: snapshot,
            participant,
            personhoodThreshold,
            readyToRegister: readyToRegister(participant, personhoodThreshold),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapOk } = await import("@parity/result");
    const { IndividualityDecodeError } = await import("./errors.js");

    /** Local hex formatter, deliberately not the one the code under test uses. */
    const hex = (bytes: Uint8Array) =>
        `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    describe("registerMessage", () => {
        test("is the raw prefix followed by the 32 account bytes: 50 bytes, no SCALE", () => {
            const account = Uint8Array.from({ length: 32 }, (_, i) => i);
            const message = registerMessage(account);
            expect(message).toHaveLength(18 + 32);
            expect(new TextDecoder().decode(message.subarray(0, 18))).toBe("pop register using");
            expect(hex(message.subarray(18))).toBe(hex(account));
        });

        test("accepts an SS58 address and embeds the decoded public key", () => {
            const fromAddress = registerMessage(ALICE);
            expect(fromAddress).toHaveLength(50);
            // Round trip: the embedded bytes rebuild the same message, so the
            // address form and the raw form cannot disagree.
            expect(registerMessage(fromAddress.subarray(18))).toEqual(fromAddress);
            // And they are the decoded key, not a hash of the address.
            expect(hex(fromAddress.subarray(18))).toBe(hex(AccountId().enc(ALICE)));
        });

        test("rejects anything but 32 account bytes", () => {
            for (const length of [0, 31, 33, 64]) {
                expect(() => registerMessage(new Uint8Array(length))).toThrow(
                    ProductIndividualityError,
                );
            }
        });

        test("a malformed address throws the package error, not PAPI's", () => {
            const malformed = [
                `0x${"aa".repeat(32)}`,
                "not-an-address",
                "",
                `${ALICE.slice(0, -1)}Z`,
            ];
            for (const address of malformed) {
                expect(() => registerMessage(address)).toThrow(ProductIndividualityError);
            }
        });

        test("the prefix is 18 bytes and never NUL-terminated or length-prefixed", () => {
            // Pins the exact framing the pallet concatenates. An encoder that
            // SCALE-encoded the prefix would put 0x48 (compact 18) first.
            const message = registerMessage(new Uint8Array(32));
            expect(message[0]).toBe("p".charCodeAt(0));
            expect(hex(message.subarray(0, 18))).toBe(hex(utf8ToBytes(REGISTER_MESSAGE_PREFIX)));
        });
    });

    describe("registerPersonhoodTx", () => {
        function fakeChain() {
            const calls: unknown[] = [];
            const chain: RegisterChain<unknown> = {
                individuality: {
                    tx: {
                        Score: {
                            register: (args) => {
                                calls.push(args);
                                return args;
                            },
                        },
                    },
                },
            };
            return { chain, calls };
        }

        test("wraps the pair in Some, hex-encoded, key first", () => {
            const { chain, calls } = fakeChain();
            registerPersonhoodTx(chain, {
                memberKey: new Uint8Array(32).fill(0xaa),
                proofOfOwnership: new Uint8Array(64).fill(0xbb),
            });
            expect(calls[0]).toEqual({
                key: [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(64)}`],
            });
        });

        test("rejects a wrong-width member key or signature before it reaches the chain", () => {
            const { chain } = fakeChain();
            expect(() =>
                registerPersonhoodTx(chain, {
                    memberKey: new Uint8Array(31),
                    proofOfOwnership: new Uint8Array(64),
                }),
            ).toThrow(ProductIndividualityError);
            expect(() =>
                registerPersonhoodTx(chain, {
                    memberKey: new Uint8Array(32),
                    proofOfOwnership: new Uint8Array(65),
                }),
            ).toThrow(ProductIndividualityError);
        });
    });

    describe("readyToRegister", () => {
        const participant = (
            overrides: Partial<PersonhoodParticipant> = {},
        ): PersonhoodParticipant => ({
            score: 0,
            streak: { tag: "Attended", count: 0 },
            attendanceHistory: 0,
            reachedPersonhood: false,
            recognition: "NotRecognized",
            lastAttendedGame: null,
            ...overrides,
        });

        test("needs a participant", () => {
            expect(readyToRegister(null, 1)).toBe(false);
        });

        test("passes on score >= threshold while NotRecognized", () => {
            expect(readyToRegister(participant({ score: 1 }), 1)).toBe(true);
            expect(readyToRegister(participant({ score: 0 }), 1)).toBe(false);
        });

        test("honours the sticky reachedPersonhood flag below the threshold", () => {
            // The threshold moves on a session schedule, so a participant who
            // reached it once keeps the claim even after it rises.
            expect(readyToRegister(participant({ reachedPersonhood: true }), 3)).toBe(true);
        });

        test("is false once recognized or suspended: different call shapes", () => {
            for (const recognition of [
                "Recognized",
                "ExternallyRecognized",
                "Suspended",
            ] as const) {
                expect(readyToRegister(participant({ score: 5, recognition }), 1)).toBe(false);
            }
        });
    });

    describe("readRegistrationEligibility", () => {
        const RAW_READY: RawParticipant = {
            score: 3,
            streak: { type: "Attended", value: 3 },
            attendance_history: 0b111,
            reached_personhood: false,
            recognition: { type: "NotRecognized" },
            last_attended_game: 14,
        };

        function fakeChain(overrides: { participant?: RawParticipant; threshold?: number } = {}) {
            const keys: unknown[] = [];
            const chain: RegistrationEligibilityChain = {
                raw: {
                    individuality: {
                        getFinalizedBlock: async () => ({
                            hash: `0x${"aa".repeat(32)}`,
                            number: 42,
                        }),
                    },
                },
                individuality: {
                    query: {
                        Score: {
                            Participants: {
                                getValue: async (key) => {
                                    keys.push(key);
                                    return overrides.participant;
                                },
                            },
                            PersonhoodThreshold: {
                                getValue: async () => overrides.threshold ?? 3,
                            },
                        },
                    },
                },
            };
            return { chain, keys };
        }

        const registrant = { tag: "Account", accountAddress: ALICE } as const;

        test("a participant at the threshold is ready, at the pinned block", async () => {
            const { chain } = fakeChain({ participant: RAW_READY });
            const value = unwrapOk(await readRegistrationEligibility(chain, { registrant }));
            expect(value.readyToRegister).toBe(true);
            expect(value.personhoodThreshold).toBe(3);
            expect(value.participant?.score).toBe(3);
            expect(value.at).toEqual({ blockHash: `0x${"aa".repeat(32)}`, blockNumber: 42 });
        });

        test("below the threshold is not ready, and the numbers say by how much", async () => {
            const { chain } = fakeChain({ participant: RAW_READY, threshold: 5 });
            const value = unwrapOk(await readRegistrationEligibility(chain, { registrant }));
            expect(value.readyToRegister).toBe(false);
            expect(value.participant?.score).toBe(3);
            expect(value.personhoodThreshold).toBe(5);
        });

        test("an unknown account is a null participant on the ok channel", async () => {
            const value = unwrapOk(
                await readRegistrationEligibility(fakeChain().chain, { registrant }),
            );
            expect(value.participant).toBeNull();
            expect(value.readyToRegister).toBe(false);
        });

        test("an already-recognized participant is not ready", async () => {
            const { chain } = fakeChain({
                participant: {
                    ...RAW_READY,
                    recognition: { type: "Recognized", value: 7n },
                },
            });
            const value = unwrapOk(await readRegistrationEligibility(chain, { registrant }));
            expect(value.readyToRegister).toBe(false);
            expect(value.participant?.recognition).toBe("Recognized");
        });

        test("keys the read by the account arm of AccountOrPerson", async () => {
            const account = fakeChain();
            await readRegistrationEligibility(account.chain, { registrant });
            expect(account.keys[0]).toEqual({ type: "Account", value: ALICE });
        });

        test("an unknown recognition variant is a decode error on the err channel", async () => {
            const { chain } = fakeChain({
                participant: { ...RAW_READY, recognition: { type: "Vaporized" } },
            });
            const result = await readRegistrationEligibility(chain, { registrant });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(IndividualityDecodeError);
            }
        });

        test("an aborted signal fails before any round trip", async () => {
            const controller = new AbortController();
            controller.abort();
            const { chain, keys } = fakeChain({ participant: RAW_READY });
            const result = await readRegistrationEligibility(chain, {
                registrant,
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
            expect(keys).toHaveLength(0);
        });

        test("a failing read arrives as the package error", async () => {
            const { chain } = fakeChain();
            chain.raw.individuality.getFinalizedBlock = async () => {
                throw new Error("node unreachable");
            };
            const result = await readRegistrationEligibility(chain, { registrant });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(ProductIndividualityError);
            }
        });
    });
}
