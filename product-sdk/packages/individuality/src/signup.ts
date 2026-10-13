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
 * // The chain picks the variant from recognition: `Account` VRFs from the
 * // signing key, or `Alias` People-ring proofs for a recognized player.
 * let airdrops;
 * if (req.value.canEnterDraws && req.value.variant === "Account") {
 *     const vrfs = await mintAccountAirdropVrfs(vrfSigner, {
 *         eventIds: req.value.eventIds,
 *         publicKey: account.publicKey,
 *     });
 *     if (!vrfs.ok) return;
 *     airdrops = vrfs.value;
 * } else if (req.value.canEnterDraws) {
 *     // The People member key is `(peopl.<tld>, Index 0)`; list it first, keys
 *     // register lazily. `productId` is `Game.product_name` under the network tld.
 *     const vrfs = await mintAliasAirdropVrfs(
 *         (context, message) =>
 *             accounts
 *                 .createRingVRFProof(peopleKey, context, peopleRing(genesis), message)
 *                 .match(
 *                     (proof) => proof,
 *                     (cause) => {
 *                         throw cause;
 *                     },
 *                 ),
 *         { eventIds: req.value.eventIds, registrant, productId: "dim2.paseo" },
 *     );
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
 * Both variants are buildable since People runtime 3004000; `signup-types.ts`
 * has the context the `Alias` proofs are verified in. The sign-up call itself is
 * `sign_up_with_account` only: `sign_up_with_alias` needs a statement-account
 * signature this package does not produce.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { bytesToHex, concatBytes, hexToBytes } from "@parity/product-sdk-utils";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { AccountId } from "polkadot-api";
import { getFakeTxCreator } from "polkadot-api/tx-creator";
import { gameAirdropEventIds } from "./airdrop-ids.js";
import type { AirdropRegistrant } from "./airdrop-types.js";
import type { BlockAt, FinalizedSnapshot, PersonhoodParticipant } from "./types.js";
import { productContext } from "./contexts.js";
import { toPersonhoodParticipant, type RawParticipant } from "./decode.js";
import { ProductIndividualityError } from "./errors.js";
import { runGameRead, type GameChain } from "./game-read.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import { playerKey, type PlayerKey } from "./player-key.js";
import type { RingVRFProof } from "./origin-extension.js";
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
    AccountVrfsNeedAnAccount: true,
    NoDrawsScheduled: true,
    NotSr25519: true,
} satisfies Record<SignUpBlocker["tag"], boolean>;

/**
 * The chain's `AirdropVrfs`, as the paseo descriptors spell it: `Alias.proofs`
 * are raw bytes, `Account` entries are `0x` hex of fixed width.
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
    /**
     * The block to read at, as PAPI's `at`: `"finalized"`, the default, `"best"`
     * to follow a best-block watch without waiting for finality, or a snapshot
     * another read already pinned.
     */
    at?: BlockAt;
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
        return ok((await runSignUpRequirementRead(chain, options, options.at)).requirement);
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
    pinnedAt?: BlockAt,
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
    // who cannot supply it. The blocker says why not. A recognized player gets
    // no blocker: `Alias` is mintable since runtime 3004000, and whether this
    // product's host grants it the People key is not readable from the chain.
    //
    // Every draw-entry blocker lives in this one chain, below the count check,
    // so none of them can name a reason for a draw that does not exist.
    const variant: AirdropVrfVariant = recognized ? "Alias" : "Account";
    if (airdropsScheduled === 0) {
        blockers.push({ tag: "NoDrawsScheduled" });
    } else if (!recognized && registrant.tag === "Alias") {
        blockers.push({ tag: "AccountVrfsNeedAnAccount" });
    } else if (!recognized && options.keyType !== undefined && options.keyType !== "sr25519") {
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
 * No local verification, though one bad entry fails the whole sign-up. The failure
 * it would guard against is the wrong key, which the transcript binds and the width
 * checks catch.
 *
 * A script with no host signs with `localAirdropVrfSigner` from the `testing` subpath.
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

/**
 * The product-scoped context one draw's proof is minted in, as the host's
 * `createRingVRFProof` takes it: the product's dotNS id and the event id as a
 * raw 32-byte suffix. Structural, so the package keeps no dependency on
 * `@parity/product-sdk-host`; the `Raw` arm of truapi's `ProductProofContext`.
 */
export interface AliasDrawProofContext {
    /** `"<product_name>.<tld>"`, lower case: the chain hashes the raw string. */
    productId: string;
    /** The draw's event id, `0x` hex, 32 bytes. */
    suffix: { tag: "Raw"; value: string };
}

/**
 * A People-ring proof over `message` in `context`.
 *
 * Wire this to `AccountsProvider.createRingVRFProof(keyHandle, context, ring,
 * message)` with the People member key (`(peopl.<tld>, Index 0)`; list it with
 * `listRingVrfKeys` first, keys register lazily) and `peopleRing(genesis)`.
 * The host grants or refuses the key per product; a refusal rejects here.
 *
 * **Neither argument is the caller's to choose.** The context is the draw's and
 * the message is the registration entry the chain verifies the proof against.
 */
export type AliasAirdropProofSigner = (
    context: AliasDrawProofContext,
    message: Uint8Array,
) => Promise<RingVRFProof>;

/** The `AirdropVrfs::Alias` arm: one proof per draw, all at one ring revision. */
export interface AliasAirdropVrfs {
    /** In airdrop-index order, raw bandersnatch ring-VRF proof bytes. */
    proofs: Uint8Array[];
    /** The ring the proofs were generated against. One for all of them. */
    ringIndex: number;
    /** That ring's revision at generation time. One for all of them. */
    revision: number;
}

/** Options for {@link mintAliasAirdropVrfs}. */
export interface MintAliasAirdropVrfsOptions {
    /** In airdrop-index order: entry `i` is checked against airdrop index `i`. */
    eventIds: string[];
    /** The identity signing up, which the chain verifies each proof against. */
    registrant: AirdropRegistrant;
    /**
     * The game's product under the network tld, e.g. `"dim2.paseo"`:
     * `Game.product_name` on chain, which every event the game schedules
     * stores, joined to the dotNS tld the host runs on. Lower case; the chain
     * hashes the raw string, so `DIM2.paseo` is a different context.
     */
    productId: string;
    /** Checked between draws only; a proof already being prompted for cannot be cancelled. */
    signal?: AbortSignal;
}

/** `RegistrationEntry`'s SCALE encoding: the variant byte, then 32 bytes of id. */
const REGISTRATION_ENTRY_ALIAS = 0;
const REGISTRATION_ENTRY_ACCOUNT = 1;
const ID_BYTES = 32;

/**
 * The message the chain verifies a draw proof against: the SCALE-encoded
 * `RegistrationEntry` of the registrant, `0u8 ++ alias` or `1u8 ++ account_id`.
 *
 * Exported for `signup-lite.ts`'s tests; not part of the package surface.
 */
export function registrationEntryBytes(registrant: AirdropRegistrant): Uint8Array {
    if (registrant.tag === "Account") {
        let accountId: Uint8Array;
        try {
            accountId = AccountId().enc(registrant.accountAddress);
        } catch (cause) {
            throw new ProductIndividualityError("registrant account is not a valid address", {
                cause,
            });
        }
        return concatBytes(Uint8Array.of(REGISTRATION_ENTRY_ACCOUNT), accountId);
    }
    const alias = bytesOfHex(registrant.alias);
    if (alias.length !== ID_BYTES) {
        throw new ProductIndividualityError("registrant alias is not 32 bytes");
    }
    return concatBytes(Uint8Array.of(REGISTRATION_ENTRY_ALIAS), alias);
}

function bytesOfHex(hex: string): Uint8Array {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
        throw new ProductIndividualityError("expected 0x-prefixed hex");
    }
    return hexToBytes(hex.slice(2));
}

/**
 * `is_product_name(label) ++ "." ++ network_suffix`: a single lower-case dotNS
 * label, then the suffix the chain is configured with, which may itself carry
 * more than one label. What matters is that the string is the one the chain
 * hashes; the pattern only rejects what certainly is not.
 */
const PRODUCT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * One People-ring proof per scheduled draw, minted through the host.
 *
 * Sequential, not parallel: each is a user-visible signing operation on a host
 * that prompts, and firing sixteen at once is hidden by an allowance until a
 * product ships without one.
 *
 * Two things are checked locally because the chain's own failure rejects the
 * whole sign-up with the deposit taken and nothing to inspect:
 *
 * - **The context.** The host decides it from `productId` and the suffix, and
 *   the proof carries it back. It must equal the context the chain derives for
 *   the event (`product/<productId>/<event_id>`, computed offline here), or the
 *   product id is misspelt, or the host hashed something else.
 * - **The ring coordinates.** `AirdropVrfs::Alias` carries one `ring_index` and
 *   one `revision` for every proof, so a ring revision moving between two
 *   draws' proofs makes the set unusable. Mint again.
 *
 * No retry on a rejected proof request: every refusal a host gives (no grant
 * for the People key, a declined prompt, a key not in the ring) holds for the
 * rest of this sign-up, so the caller should sign up without the draws rather
 * than ask again.
 *
 * @throws nothing; every failure is on the `err` channel, with the host's
 *   rejection as the cause.
 */
export async function mintAliasAirdropVrfs(
    signer: AliasAirdropProofSigner,
    options: MintAliasAirdropVrfsOptions,
): Promise<Result<AliasAirdropVrfs, ProductIndividualityError>> {
    try {
        if (!PRODUCT_ID_PATTERN.test(options.productId)) {
            throw new ProductIndividualityError(
                "product id must be a lower-case dotNS name such as dim2.paseo",
            );
        }
        const message = registrationEntryBytes(options.registrant);
        const proofs: Uint8Array[] = [];
        let ring: { ringIndex: number; revision: number } | undefined;

        for (const eventId of options.eventIds) {
            options.signal?.throwIfAborted();
            const eventIdBytes = bytesOfHex(eventId);
            if (eventIdBytes.length !== ID_BYTES) {
                throw new ProductIndividualityError("airdrop event id is not 32 bytes");
            }
            const expectedContext = productContext(options.productId, {
                tag: "Raw",
                value: eventIdBytes,
            });

            const proof = checkDrawProof(
                await signer(
                    { productId: options.productId, suffix: { tag: "Raw", value: eventId } },
                    message,
                ),
            );
            if (!sameBytes(proof.contextualAlias.context, expectedContext)) {
                // The context, not the alias: the alias is pseudonymous identity.
                throw new ProductIndividualityError(
                    "draw proof was minted in a different context than the chain verifies; check productId",
                );
            }
            if (ring === undefined) {
                ring = { ringIndex: proof.ringIndex, revision: proof.ringRevision };
            } else if (ring.ringIndex !== proof.ringIndex || ring.revision !== proof.ringRevision) {
                throw new ProductIndividualityError(
                    "draw proofs were minted against different ring revisions; mint them again",
                );
            }
            proofs.push(proof.proof);
        }

        return ok({ proofs, ringIndex: ring?.ringIndex ?? 0, revision: ring?.revision ?? 0 });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/**
 * The adapter is caller-written and usually unwraps a `Result`, so resolving
 * with the `Result` itself is a likelier mistake than rejecting.
 */
function checkDrawProof(value: RingVRFProof): RingVRFProof {
    if (
        !(value?.proof instanceof Uint8Array) ||
        value.proof.length === 0 ||
        !(value?.contextualAlias?.context instanceof Uint8Array) ||
        typeof value?.ringIndex !== "number" ||
        typeof value?.ringRevision !== "number"
    ) {
        throw new ProductIndividualityError(
            "the proof signer returned no ring VRF proof; unwrap the Result before resolving",
        );
    }
    return value;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Options for {@link signUpWithAccountTx}. */
export interface SignUpWithAccountOptions {
    /**
     * `CommunicationIdentifier`, exactly 65 bytes. Stored against the account and
     * never interpreted by the chain; it is how co-players reach each other.
     */
    identifierKey: Uint8Array;
    /**
     * Omit to enter no draw. Count must equal {@link airdropsScheduled}: a list
     * of account VRFs from {@link mintAccountAirdropVrfs}, or the alias arm from
     * {@link mintAliasAirdropVrfs}. Which one is the chain's choice, read from
     * `GameSignUpRequirement.variant`; the other is rejected on chain.
     */
    airdrops?: AccountVrfSignature[] | AliasAirdropVrfs;
    /**
     * From {@link GameSignUpRequirement}, checked against `airdrops` when both are
     * given. A mismatch fails the whole sign-up on chain with the deposit taken,
     * and is reachable by re-reading the requirement between minting and building.
     */
    airdropsScheduled?: number;
}

/** `CommunicationIdentifier`. Exported for `roster.ts`, which reads it back. */
export const IDENTIFIER_KEY_BYTES = 65;
const VRF_PRE_OUTPUT_BYTES = 32;
const VRF_PROOF_BYTES = 64;

/**
 * Build `Game.sign_up_with_account`, unsigned. `Pays::No` on success, though a new
 * or archived player still pays a deposit.
 *
 * `airdrops` takes either arm; the chain decides which one it accepts from this
 * player's recognition, so build the one `GameSignUpRequirement.variant` names.
 *
 * A returning player owes no deposit and can sign under `withScoreParticipant` to
 * skip the fee as well, which is how a zero-balance account signs up again. A new
 * or archived player owes the deposit, so sign plainly.
 *
 * @throws ProductIndividualityError on a wrong-width key, signature or proof, or
 *   an airdrop count that disagrees with `airdropsScheduled`. Checked because
 *   the chain's own failure rejects the sign-up with nothing to inspect.
 */
export function signUpWithAccountTx<Tx>(
    chain: SignUpChain<Tx>,
    options: SignUpWithAccountOptions,
): Tx {
    return chain.individuality.tx.Game.sign_up_with_account({
        identifier_key: identifierKeyHex(options.identifierKey),
        airdrops: airdropsArg(options),
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

/** Sanity ceiling on one ring-VRF proof; a real one is under a kilobyte. */
const ALIAS_PROOF_BYTES_MAX = 8 * 1024;

/**
 * `airdrops` for either sign-up call: whichever arm the caller built. A list is
 * the `Account` arm; {@link AliasAirdropVrfs} is the `Alias` arm. `undefined`
 * is PAPI's `None`. Exported for `signup-lite.ts`; not part of the package surface.
 */
export function airdropsArg(options: {
    airdrops?: AccountVrfSignature[] | AliasAirdropVrfs;
    airdropsScheduled?: number;
}): AirdropVrfsArg | undefined {
    if (options.airdrops === undefined || Array.isArray(options.airdrops)) {
        return accountAirdropsArg({
            airdrops: options.airdrops,
            airdropsScheduled: options.airdropsScheduled,
        });
    }
    return aliasAirdropsArg(options.airdrops, options.airdropsScheduled);
}

function aliasAirdropsArg(alias: AliasAirdropVrfs, airdropsScheduled?: number): AirdropVrfsArg {
    const count = alias.proofs.length;
    if (airdropsScheduled !== undefined && count !== airdropsScheduled) {
        throw new ProductIndividualityError(
            `game sign-up needs one airdrop proof per scheduled draw, got ${count} for ${airdropsScheduled}`,
        );
    }
    for (const proof of alias.proofs) {
        if (!(proof instanceof Uint8Array) || proof.length === 0) {
            throw new ProductIndividualityError("airdrop ring VRF proof is empty");
        }
        if (proof.length > ALIAS_PROOF_BYTES_MAX) {
            throw new ProductIndividualityError(
                "airdrop ring VRF proof is larger than the chain will accept",
            );
        }
    }
    return {
        type: "Alias",
        value: { proofs: alias.proofs, ring_index: alias.ringIndex, revision: alias.revision },
    };
}

function sizedSignaturePart(bytes: Uint8Array, length: number, what: string): Uint8Array {
    if (bytes.length !== length) {
        throw new ProductIndividualityError(`airdrop VRF ${what} must be ${length} bytes`);
    }
    return bytes;
}

/** A built transaction whose fee can be estimated, as every PAPI 3 transaction can. */
export interface FeeEstimable {
    getEstimatedFees(creator: CommonSignerTxCreator, options: { nonce: number }): Promise<bigint>;
}

/**
 * What {@link readSignUpFunds} reads. Matched by hand against the paseo descriptors
 * on 2026-09-25:
 *
 * ```
 * Game.PlayDepositAmount: StorageDescriptor<[], bigint, false, never>
 * System.Account:         StorageDescriptor<[Key: SS58String], AccountInfo, false, never>
 * ```
 */
export type SignUpFundsChain = PinnedChain & {
    individuality: {
        query: {
            Game: { PlayDepositAmount: { getValue(options: ReadAt): Promise<bigint> } };
            System: {
                Account: {
                    getValue(account: string, options: ReadAt): Promise<{ data: { free: bigint } }>;
                };
            };
        };
    };
    raw: {
        individuality: {
            /** Where the chain publishes its token decimals and symbol. */
            getChainSpecData(): Promise<{ properties?: unknown }>;
        };
    };
};

/** Options for {@link readSignUpFunds}. */
export interface ReadSignUpFundsOptions {
    /** SS58. The account that will sign and hold the deposit. */
    account: string;
    /**
     * The sign-up transaction as built, for example by {@link signUpWithAccountTx}.
     * Omit it and `estimatedFee` is `null`. Placeholder VRFs of the right width cost
     * the same as real ones, so the funds can be checked before any is minted.
     */
    tx?: FeeEstimable;
    /**
     * The block to read at, as PAPI's `at`: `"finalized"`, the default, `"best"`
     * to follow a best-block watch without waiting for finality, or a snapshot
     * another read already pinned.
     */
    at?: BlockAt;
    signal?: AbortSignal;
}

/**
 * The parts of what a sign-up costs, in the smallest unit of the native token.
 *
 * How much headroom to demand on top is product policy, so no total is given.
 */
export interface SignUpFunds {
    at: FinalizedSnapshot;
    /**
     * Held from a new or archived player at sign-up. A returning player owes none,
     * and an existing deposit keeps the amount it was created with.
     */
    deposit: bigint;
    /**
     * Charged up front and refunded on success, so the account needs it to start
     * with. Nothing under `withScoreParticipant`. PAPI estimates it at the latest
     * finalized block, which can be newer than `at`.
     */
    estimatedFee: bigint | null;
    /**
     * The raw free balance, which is more than a sign-up can spend.
     *
     * The fee cannot come out of frozen funds, and neither the fee nor the deposit
     * may take the account below the existential deposit. So a check that `free`
     * covers `deposit + estimatedFee` can pass while the sign-up fails.
     */
    free: bigint;
    /** `null` when the chain spec does not publish it. */
    decimals: number | null;
    symbol: string | null;
}

/**
 * The deposit, the free balance and the fee of a sign-up.
 *
 * The deposit and the balance come from one pinned finalized block, the fee from
 * wherever PAPI estimates it, see {@link SignUpFunds.estimatedFee}.
 */
export async function readSignUpFunds(
    chain: SignUpFundsChain,
    options: ReadSignUpFundsOptions,
): Promise<Result<SignUpFunds, ProductIndividualityError>> {
    try {
        const { account, tx, signal } = options;
        const query = chain.individuality.query;
        const snapshot = await pinBlock(chain, signal, options.at);
        const at = readAt(snapshot, signal);

        const [deposit, info, estimatedFee, spec] = await Promise.all([
            query.Game.PlayDepositAmount.getValue(at),
            query.System.Account.getValue(account, at),
            // A fixed nonce saves the nonce lookup PAPI runs before estimating, and
            // moves the length by a few bytes at most. The fake creator prices the
            // call as a plain signed transaction from `account`, which is a few
            // bytes shorter than the person-origin one and never prompts anyone.
            tx === undefined ? null : tx.getEstimatedFees(getFakeTxCreator(account), { nonce: 0 }),
            chain.raw.individuality.getChainSpecData(),
        ]);
        const token = tokenProperties(spec.properties);
        return ok({ at: snapshot, deposit, estimatedFee, free: info.data.free, ...token });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** Multi-token chains publish a list, and the native token is the first entry. */
function tokenProperties(properties: unknown): { decimals: number | null; symbol: string | null } {
    const { tokenDecimals, tokenSymbol } = (properties ?? {}) as {
        tokenDecimals?: unknown;
        tokenSymbol?: unknown;
    };
    const decimals = Array.isArray(tokenDecimals) ? tokenDecimals[0] : tokenDecimals;
    const symbol = Array.isArray(tokenSymbol) ? tokenSymbol[0] : tokenSymbol;
    return {
        decimals:
            Number.isInteger(decimals) && (decimals as number) >= 0 ? (decimals as number) : null,
        symbol: typeof symbol === "string" && symbol.length > 0 ? symbol : null,
    };
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
        has_ever_reached_personhood: true,
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

        test("reads at the block it is given", async () => {
            const { chain } = fakeChain();
            const given = { blockHash: `0x${"bb".repeat(32)}`, blockNumber: 43 };
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 1_000, at: given }),
            );
            expect(value.at).toBe(given);
        });

        test("a recognized player enters the draws with the Alias arm", async () => {
            // Since runtime 3004000 the proofs are mintable, so there is no
            // blocker; whether this product may use the People key is the
            // host's decision and surfaces from the mint, not from a read.
            const { chain } = fakeChain({ participant: RECOGNIZED });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, { registrant, now: 1_000 }),
            );

            expect(value.variant).toBe("Alias");
            expect(value.canSignUp).toBe(true);
            expect(value.canEnterDraws).toBe(true);
            expect(value.blockers).toEqual([]);
        });

        test("a recognized player's key type does not matter: the proofs are ring VRFs", async () => {
            const { chain } = fakeChain({ participant: RECOGNIZED });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, {
                    registrant,
                    now: 1_000,
                    keyType: "ed25519",
                }),
            );
            expect(value.blockers).toEqual([]);
        });

        test("a suspended player is not recognized, so it stays on the account path", async () => {
            // `is_recognized()` is false for Suspended, so "not NotRecognized" is
            // the wrong test and would send this player to the arm the chain rejects.
            const { chain } = fakeChain({
                participant: {
                    score: 1,
                    streak: { type: "Absent", value: 2 },
                    attendance_history: 0,
                    reached_personhood: false,
                    has_ever_reached_personhood: false,
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

        test("a recognized person has no origin blocker: the alias arm takes an alias entry", async () => {
            const { chain } = fakeChain({ participant: RECOGNIZED });
            const value = unwrapOk(
                await readGameSignUpRequirement(chain, {
                    registrant: { tag: "Alias", alias: ALIAS },
                    now: 1_000,
                }),
            );

            expect(value.variant).toBe("Alias");
            expect(value.blockers).toEqual([]);
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

    describe("registrationEntryBytes", () => {
        // Alice's account id, so a wrong decoder is a visible 32-byte diff.
        const ALICE_HEX = "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
        const hex = (bytes: Uint8Array) =>
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

        test("an account player is 1u8 ++ account_id, the SCALE of RegistrationEntry::Account", () => {
            expect(hex(registrationEntryBytes(registrant))).toBe(`01${ALICE_HEX}`);
        });

        test("an alias player is 0u8 ++ alias", () => {
            expect(hex(registrationEntryBytes({ tag: "Alias", alias: ALIAS }))).toBe(
                `00${"dd".repeat(32)}`,
            );
        });

        test("rejects an alias that is not 32 bytes, and an address that does not decode", () => {
            expect(() => registrationEntryBytes({ tag: "Alias", alias: "0xdd" })).toThrow(
                ProductIndividualityError,
            );
            expect(() =>
                registrationEntryBytes({ tag: "Account", accountAddress: "not an address" }),
            ).toThrow(ProductIndividualityError);
        });
    });

    describe("mintAliasAirdropVrfs", () => {
        const PRODUCT_ID = "dim2.paseo";
        const EVENT_IDS = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`];
        const contextOf = (eventId: string) =>
            productContext(PRODUCT_ID, { tag: "Raw", value: hexToBytes(eventId.slice(2)) });

        /** A host double: records every request and answers in the right context. */
        function fakeSigner(
            overrides: {
                contextFor?: (eventId: string) => Uint8Array;
                ringFor?: (index: number) => { ringIndex: number; ringRevision: number };
            } = {},
        ) {
            const requests: { context: AliasDrawProofContext; message: Uint8Array }[] = [];
            const signer: AliasAirdropProofSigner = async (context, message) => {
                requests.push({ context, message });
                const index = requests.length - 1;
                const ring = overrides.ringFor?.(index) ?? { ringIndex: 3, ringRevision: 7 };
                return {
                    proof: Uint8Array.from([0xa0 + index, 0xbb, 0xcc]),
                    contextualAlias: {
                        context:
                            overrides.contextFor?.(context.suffix.value) ??
                            contextOf(context.suffix.value),
                        alias: new Uint8Array(32),
                    },
                    ...ring,
                };
            };
            return { signer, requests };
        }

        test("mints one proof per draw, in order, at one ring revision", async () => {
            const { signer, requests } = fakeSigner();
            const value = unwrapOk(
                await mintAliasAirdropVrfs(signer, {
                    eventIds: EVENT_IDS,
                    registrant,
                    productId: PRODUCT_ID,
                }),
            );

            expect(value.proofs.map((proof) => proof[0])).toEqual([0xa0, 0xa1]);
            expect(value.ringIndex).toBe(3);
            expect(value.revision).toBe(7);
            expect(requests).toHaveLength(2);
        });

        test("asks for the draw's context: the product id and the event id as a raw suffix", async () => {
            const { signer, requests } = fakeSigner();
            await mintAliasAirdropVrfs(signer, {
                eventIds: EVENT_IDS,
                registrant,
                productId: PRODUCT_ID,
            });

            expect(requests.map((request) => request.context)).toEqual(
                EVENT_IDS.map((eventId) => ({
                    productId: PRODUCT_ID,
                    suffix: { tag: "Raw", value: eventId },
                })),
            );
        });

        test("signs the registration entry, never a caller-chosen message", async () => {
            const { signer, requests } = fakeSigner();
            await mintAliasAirdropVrfs(signer, {
                eventIds: EVENT_IDS,
                registrant: { tag: "Alias", alias: ALIAS },
                productId: PRODUCT_ID,
            });

            for (const request of requests) {
                expect(request.message).toEqual(
                    registrationEntryBytes({ tag: "Alias", alias: ALIAS }),
                );
            }
        });

        test("rejects a proof the host minted in another context", async () => {
            // A misspelt product id, or a host hashing something else: the
            // chain would reject the whole sign-up with the deposit taken.
            const { signer } = fakeSigner({ contextFor: () => new Uint8Array(32) });
            const error = unwrapErr(
                await mintAliasAirdropVrfs(signer, {
                    eventIds: EVENT_IDS,
                    registrant,
                    productId: PRODUCT_ID,
                }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(error.message).toMatch(/productId/);
        });

        test("rejects proofs that disagree on the ring revision", async () => {
            const { signer } = fakeSigner({
                ringFor: (index) => ({ ringIndex: 3, ringRevision: 7 + index }),
            });
            const error = unwrapErr(
                await mintAliasAirdropVrfs(signer, {
                    eventIds: EVENT_IDS,
                    registrant,
                    productId: PRODUCT_ID,
                }),
            );
            expect(error.message).toMatch(/ring revisions/);
        });

        test("rejects a product id the chain would hash differently", async () => {
            const { signer, requests } = fakeSigner();
            for (const productId of [
                "DIM2.paseo",
                "dim2",
                "dim2.paseo/",
                "dim2..paseo",
                ".paseo",
            ]) {
                const error = unwrapErr(
                    await mintAliasAirdropVrfs(signer, {
                        eventIds: EVENT_IDS,
                        registrant,
                        productId,
                    }),
                );
                expect(error).toBeInstanceOf(ProductIndividualityError);
            }
            expect(requests).toHaveLength(0);
        });

        test("accepts a network suffix of more than one label", async () => {
            // The chain hashes whatever suffix it is configured with; a host
            // may run under one with several labels.
            const { signer, requests } = fakeSigner({
                contextFor: (eventId) =>
                    productContext("dim2.next.paseo", {
                        tag: "Raw",
                        value: hexToBytes(eventId.slice(2)),
                    }),
            });
            const value = unwrapOk(
                await mintAliasAirdropVrfs(signer, {
                    eventIds: EVENT_IDS,
                    registrant,
                    productId: "dim2.next.paseo",
                }),
            );
            expect(value.proofs).toHaveLength(2);
            expect(requests[0].context.productId).toBe("dim2.next.paseo");
        });

        test("rejects an event id that is not 32 bytes before asking the host", async () => {
            const { signer, requests } = fakeSigner();
            const error = unwrapErr(
                await mintAliasAirdropVrfs(signer, {
                    eventIds: ["0x0102"],
                    registrant,
                    productId: PRODUCT_ID,
                }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(requests).toHaveLength(0);
        });

        test("keeps the host's rejection as the cause", async () => {
            const boom = new Error("not allowlisted");
            const error = unwrapErr(
                await mintAliasAirdropVrfs(
                    async () => {
                        throw boom;
                    },
                    { eventIds: EVENT_IDS, registrant, productId: PRODUCT_ID },
                ),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(error.cause).toBe(boom);
        });

        test("reports a signer that resolves with the wrong shape", async () => {
            const error = unwrapErr(
                await mintAliasAirdropVrfs(
                    // A Result left unwrapped, the likeliest adapter mistake.
                    async () => ({ ok: true, value: {} }) as unknown as RingVRFProof,
                    { eventIds: EVENT_IDS, registrant, productId: PRODUCT_ID },
                ),
            );
            expect(error.message).toMatch(/unwrap the Result/);
        });

        test("stops between draws when aborted", async () => {
            const controller = new AbortController();
            const { signer, requests } = fakeSigner();
            const error = unwrapErr(
                await mintAliasAirdropVrfs(
                    async (context, message) => {
                        const proof = await signer(context, message);
                        controller.abort();
                        return proof;
                    },
                    {
                        eventIds: EVENT_IDS,
                        registrant,
                        productId: PRODUCT_ID,
                        signal: controller.signal,
                    },
                ),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(requests).toHaveLength(1);
        });

        test("no draws means no proofs and no host round trip", async () => {
            const { signer, requests } = fakeSigner();
            const value = unwrapOk(
                await mintAliasAirdropVrfs(signer, {
                    eventIds: [],
                    registrant,
                    productId: PRODUCT_ID,
                }),
            );
            expect(value.proofs).toEqual([]);
            expect(requests).toHaveLength(0);
        });
    });

    describe("signUpWithAccountTx with the Alias arm", () => {
        const ALIAS_VRFS: AliasAirdropVrfs = {
            proofs: [Uint8Array.from([0xaa]), Uint8Array.from([0xbb])],
            ringIndex: 3,
            revision: 7,
        };

        test("encodes the arm as the chain's AirdropVrfs::Alias", () => {
            const { chain, calls } = fakeChain();
            signUpWithAccountTx(chain, {
                identifierKey: IDENTIFIER,
                airdrops: ALIAS_VRFS,
                airdropsScheduled: 2,
            });
            expect(calls.tx[0]).toEqual({
                identifier_key: `0x${"22".repeat(65)}`,
                airdrops: {
                    type: "Alias",
                    value: { proofs: ALIAS_VRFS.proofs, ring_index: 3, revision: 7 },
                },
            });
        });

        test("checks the proof count against airdropsScheduled", () => {
            const { chain, calls } = fakeChain();
            expect(() =>
                signUpWithAccountTx(chain, {
                    identifierKey: IDENTIFIER,
                    airdrops: ALIAS_VRFS,
                    airdropsScheduled: 3,
                }),
            ).toThrow(ProductIndividualityError);
            expect(calls.tx).toHaveLength(0);
        });

        test("rejects an empty proof", () => {
            const { chain } = fakeChain();
            expect(() =>
                signUpWithAccountTx(chain, {
                    identifierKey: IDENTIFIER,
                    airdrops: { ...ALIAS_VRFS, proofs: [new Uint8Array(0), ALIAS_VRFS.proofs[1]] },
                }),
            ).toThrow(ProductIndividualityError);
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

    describe("readSignUpFunds", () => {
        const BLOCK = { hash: `0x${"99".repeat(32)}`, number: 321 };

        function fundsChain(
            overrides: { properties?: unknown; failOn?: "deposit" | "account" | "spec" } = {},
        ) {
            const calls: Array<{ entry: string; at: string }> = [];
            const chain: SignUpFundsChain = {
                individuality: {
                    query: {
                        Game: {
                            PlayDepositAmount: {
                                getValue: async (options) => {
                                    options.signal?.throwIfAborted();
                                    calls.push({ entry: "PlayDepositAmount", at: options.at });
                                    if (overrides.failOn === "deposit")
                                        throw new Error("deposit unreachable");
                                    return 2_000_000_000_000n;
                                },
                            },
                        },
                        System: {
                            Account: {
                                getValue: async (account, options) => {
                                    calls.push({ entry: `Account:${account}`, at: options.at });
                                    if (overrides.failOn === "account")
                                        throw new Error("account unreachable");
                                    return { data: { free: 5_000_000_000_000n } };
                                },
                            },
                        },
                    },
                },
                raw: {
                    individuality: {
                        getFinalizedBlock: async () => BLOCK,
                        getBestBlocks: async () => [BLOCK],
                        getChainSpecData: async () => {
                            if (overrides.failOn === "spec") throw new Error("spec unreachable");
                            return {
                                properties:
                                    "properties" in overrides
                                        ? overrides.properties
                                        : { tokenDecimals: 10, tokenSymbol: "PAS" },
                            };
                        },
                    },
                },
            };
            return { chain, calls };
        }

        const feeTx = (fee: bigint) => {
            const estimates: Array<{ from: Uint8Array; options: unknown }> = [];
            const tx: FeeEstimable = {
                getEstimatedFees: async (creator, options) => {
                    estimates.push({
                        from: (creator as unknown as { publicKey: Uint8Array }).publicKey,
                        options,
                    });
                    return fee;
                },
            };
            return { tx, estimates };
        };

        test("returns the parts of the cost, and the token they are counted in", async () => {
            const { chain } = fundsChain();
            const { tx } = feeTx(12_345n);
            expect(unwrapOk(await readSignUpFunds(chain, { account: ACCOUNT, tx }))).toEqual({
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
                deposit: 2_000_000_000_000n,
                estimatedFee: 12_345n,
                free: 5_000_000_000_000n,
                decimals: 10,
                symbol: "PAS",
            });
        });

        test("reads every entry at the block it is given", async () => {
            const { chain, calls } = fundsChain();
            const given = { blockHash: `0x${"bb".repeat(32)}`, blockNumber: 43 };
            const funds = unwrapOk(await readSignUpFunds(chain, { account: ACCOUNT, at: given }));
            expect(funds.at).toBe(given);
            expect(calls.map((call) => call.at)).toEqual([given.blockHash, given.blockHash]);
        });

        test("reads every entry at the pinned block, and estimates the fee for the account", async () => {
            const { chain, calls } = fundsChain();
            const { tx, estimates } = feeTx(1n);
            await readSignUpFunds(chain, { account: ACCOUNT, tx });
            expect(calls).toEqual([
                { entry: "PlayDepositAmount", at: BLOCK.hash },
                { entry: `Account:${ACCOUNT}`, at: BLOCK.hash },
            ]);
            expect(estimates).toEqual([{ from: AccountId().enc(ACCOUNT), options: { nonce: 0 } }]);
        });

        test("has no fee without a transaction to estimate", async () => {
            const { chain } = fundsChain();
            const funds = unwrapOk(await readSignUpFunds(chain, { account: ACCOUNT }));
            expect(funds.estimatedFee).toBeNull();
        });

        test("takes the first token of a multi-token chain spec", async () => {
            const { chain } = fundsChain({
                properties: { tokenDecimals: [12, 6], tokenSymbol: ["DOT", "USDT"] },
            });
            const funds = unwrapOk(await readSignUpFunds(chain, { account: ACCOUNT }));
            expect([funds.decimals, funds.symbol]).toEqual([12, "DOT"]);
        });

        test.each([
            ["no properties", undefined],
            ["no token fields", {}],
            ["malformed token fields", { tokenDecimals: "ten", tokenSymbol: "" }],
        ])("leaves the token null with %s, rather than guessing one", async (_, properties) => {
            const { chain } = fundsChain({ properties });
            const funds = unwrapOk(await readSignUpFunds(chain, { account: ACCOUNT }));
            expect([funds.decimals, funds.symbol]).toEqual([null, null]);
        });

        test.each(["deposit", "account", "spec"] as const)(
            "a failure reading the %s arrives on the err channel with its cause",
            async (failOn) => {
                const { chain } = fundsChain({ failOn });
                const error = unwrapErr(await readSignUpFunds(chain, { account: ACCOUNT }));
                expect(error).toBeInstanceOf(ProductIndividualityError);
                expect((error.cause as Error).message).toBe(`${failOn} unreachable`);
            },
        );

        test("an already-aborted signal costs no round trip", async () => {
            const { chain, calls } = fundsChain();
            const controller = new AbortController();
            controller.abort();
            const error = unwrapErr(
                await readSignUpFunds(chain, { account: ACCOUNT, signal: controller.signal }),
            );
            expect(error).toBeInstanceOf(ProductIndividualityError);
            expect(calls).toHaveLength(0);
        });
    });
}
