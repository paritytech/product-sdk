// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The free lite-personhood game sign-up: what the chain would accept from this
 * account, and the call that signs it up.
 *
 * The lite sign-up is two transactions, never one. First
 * `PeopleLite.set_alias_account(account, valid_at_block)` binds the lite
 * person's alias to `account` in the chain's score context — an unsigned
 * general transaction authorized by a ring-VRF proof, submitted through
 * `withLiteAlias({ tag: "AliasWithProof", createProof })`. Then
 * `Game.sign_up_with_account_lite_invite(account, identifier_key, airdrops)`
 * rides that binding: **signed by `account`** with
 * `withLiteAlias({ tag: "AliasWithAccount" })`, `Pays::No`, no deposit, valid
 * on a zero balance. This module serves the second leg and the read that
 * decides whether either leg is worth submitting; the first leg is an ordinary
 * `api.tx.PeopleLite.set_alias_account` the caller builds and submits with the
 * proof signer.
 *
 * ```ts
 * const req = await readLiteSignUpRequirement(chain, { account, liteMemberKey });
 * if (req.ok && req.value.canSignUp) {
 *     const tx = signUpWithLiteInviteTx(chain, { account, identifierKey, airdrops });
 *     await submitAndWatch(tx, withLiteAlias(signer, { tag: "AliasWithAccount" }));
 * }
 * ```
 *
 * The read is {@link readGameSignUpRequirement} plus the lite gates, all at one
 * pinned block, and its blockers are a superset of the account read's
 * (`LiteSignUpBlocker` in `signup-types.ts`). Two of its facts are easy to get
 * wrong from the pallet docs alone:
 *
 * - **`Game.LiteInvites[alias]` pins forever** the one account a lite person
 *   may ever invite. The first lite sign-up writes it; every later one must
 *   name the same account or fails with `AnotherAccountInvited`. The blocker
 *   carries the pinned account so a UI can say *which* seat is taken.
 * - **`Game.CommunicationIdentifiers[account]` is rewritten on every sign-up
 *   variant**, so an existing entry is never a blocker and the key is chosen
 *   fresh here, by whoever will actually play.
 *
 * Nothing here chooses a chain, a product id or a TLD. The account is the
 * caller's (usually its playing product account), the score context comes from
 * the chain via `runScoreContextRead` against the block this read already
 * pinned, and the 65-byte `identifierKey` is a
 * caller-supplied parameter this package never derives.
 */
import { AccountId } from "polkadot-api";
import { err, normalizeError, ok, type Result } from "@parity/result";
import { bytesToHex } from "@parity/product-sdk-utils";
import { ProductIndividualityError } from "./errors.js";
import type { GameChain } from "./game-read.js";
import { pinBlock, readAt, type ReadAt } from "./pinned.js";
import {
    ringCollectionId,
    runScoreContextRead,
    type AnyScoreContextChain,
    type LegacySuffixChain,
    type NetworkSuffixChain,
    type ScoreContextChain,
} from "./rings.js";
import type {
    AccountVrfSignature,
    LiteSignUpBlocker,
    LiteSignUpRequirement,
} from "./signup-types.js";
import {
    accountAirdropsArg,
    identifierKeyHex,
    runSignUpRequirementRead,
    type AirdropVrfsArg,
    type SignUpChain,
} from "./signup.js";

/**
 * `PeopleLite.AccountToAlias`, the alias binding the signed leg dispatches on.
 * `ca.context` is read as well as `ca.alias`: a binding in any context other
 * than the chain's score context does not satisfy the game's origin check.
 */
export interface RawLiteAliasBinding {
    /** Ring revision the binding was proven at. */
    revision: number;
    /** Ring the alias belongs to. */
    ring: number;
    /** The contextual alias itself, both halves as `0x` hex. */
    ca: { alias: string; context: string };
}

/**
 * One `Members.Members` entry, narrowed to the discriminant. Only `Included`
 * means the key sits in a built ring and a proof against it will verify.
 */
export interface RawLiteRingMembership {
    type: string;
}

type LiteInviteTxArgs = {
    account: string;
    identifier_key: string;
    airdrops?: AirdropVrfsArg;
};

/**
 * The lite sign-up call, plus the reads that decide whether it can dispatch.
 * Composed with {@link GameChain} and {@link SignUpChain}, which supply the
 * game and the account-path reads. Matched by hand against the paseo and
 * previewnet descriptors on 2026-08-31 (devnet predates the surface):
 *
 * ```
 * PeopleLite.AccountToAlias: StorageDescriptor<[Key: SS58String], { revision, ring, ca }, true, never>
 * PeopleLite.LitePeople:     StorageDescriptor<[Key: SS58String], LitePersonInfo, true, never>
 * Game.LiteInvites:          StorageDescriptor<[Key: SizedHex<32>], SS58String, true, never>
 * Members.Members:           StorageDescriptor<[SizedHex<32>, SizedHex<32>], MemberStatus, true, never>
 * ```
 */
export interface LiteSignUpChain<Tx = unknown> {
    individuality: {
        query: {
            PeopleLite: {
                /** Absent until `set_alias_account` has bound this account. */
                AccountToAlias: {
                    getValue(
                        key: string,
                        options: ReadAt,
                    ): Promise<RawLiteAliasBinding | undefined>;
                };
                /** Presence is the signal: this account is itself a lite person. */
                LitePeople: {
                    getValue(key: string, options: ReadAt): Promise<unknown>;
                };
            };
            Game: {
                /** The one account this lite alias may ever invite, once set. */
                LiteInvites: {
                    getValue(key: string, options: ReadAt): Promise<string | undefined>;
                };
            };
            Members: {
                /** Keyed by collection id then member key, both 32-byte hex. */
                Members: {
                    getValue(
                        collection: string,
                        key: string,
                        options: ReadAt,
                    ): Promise<RawLiteRingMembership | undefined>;
                };
                /** The ring's current revision, which a binding can fall behind. */
                Root: {
                    getValue(
                        collection: string,
                        ring: number,
                        options: ReadAt,
                    ): Promise<{ revision: number } | undefined>;
                };
            };
        };
        tx: {
            Game: {
                sign_up_with_account_lite_invite(args: LiteInviteTxArgs): Tx;
            };
        };
    };
}

/** Options for {@link readLiteSignUpRequirement}. */
export interface ReadLiteSignUpRequirementOptions {
    /**
     * The account the sign-up will be **signed by** and dispatched for —
     * usually the caller's playing product account. Keys the alias-binding
     * read here and the registration reads of the account path.
     */
    account: string;
    /**
     * The 32-byte lite member key (RFC-0022 index 1, from the host's
     * `registerRingVrfKey` against the lite people ring). Pass it for a
     * `NotLiteMember` blocker when the key is not an `Included` ring member;
     * omit it and the membership check is yours.
     */
    liteMemberKey?: Uint8Array;
    /** Forwarded to the account read's draw-entry check. */
    keyType?: "sr25519" | "ed25519" | "ecdsa";
    /** Unix **seconds**; defaults to the device clock. */
    now?: number;
    /** Required when the chain publishes no suffix, and wins when it does. */
    tld?: string;
    signal?: AbortSignal;
}

/** Ring-VRF member keys are 32 bytes, like everything else `Members` keys on. */
const LITE_MEMBER_KEY_BYTES = 32;

/** Lowercase, unprefixed — the one shape two hex spellings can be compared in. */
function normalizedHex(value: string): string {
    return (value.startsWith("0x") ? value.slice(2) : value).toLowerCase();
}

/** The chain's SS58 prefix need not be the caller's. */
function sameAccount(left: string, right: string): boolean {
    const codec = AccountId();
    const a = codec.enc(left);
    const b = codec.enc(right);
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * What this account may do about the free lite sign-up, at one pinned block:
 * the account sign-up read plus the lite gates, with the blockers merged.
 *
 * `canSignUp` answers for `sign_up_with_account_lite_invite` specifically —
 * every lite blocker stops the sign-up itself, so it is the account read's
 * answer AND'ed with "no lite blocker". The draw-entry split (`canEnterDraws`,
 * the draw-only blockers) carries over from {@link readGameSignUpRequirement}
 * unchanged: the draws ride on the sign-up here exactly as they do there.
 *
 * An `AliasNotBound` answer is not a dead end — it says the bind leg
 * (`PeopleLite.set_alias_account` under `withLiteAlias(AliasWithProof)`) has
 * not run yet. `AnotherAccountInvited` and `AccountIsALitePerson` are dead ends
 * **for this account**; `AliasBoundElsewhere` is recoverable, but only through
 * a call this package cannot make. `signup-types.ts` has the detail per arm.
 *
 * `Game.LiteInvites` is consulted only when a binding in the score context
 * exists: the invite pin is keyed by the alias, and without the binding the
 * alias is unknown here.
 */
export async function readLiteSignUpRequirement(
    chain: GameChain & SignUpChain & ScoreContextChain & NetworkSuffixChain & LiteSignUpChain,
    options: ReadLiteSignUpRequirementOptions,
): Promise<Result<LiteSignUpRequirement, ProductIndividualityError>>;
export async function readLiteSignUpRequirement(
    chain: GameChain & SignUpChain & ScoreContextChain & LegacySuffixChain & LiteSignUpChain,
    options: ReadLiteSignUpRequirementOptions,
): Promise<Result<LiteSignUpRequirement, ProductIndividualityError>>;
export async function readLiteSignUpRequirement(
    chain: GameChain & SignUpChain & ScoreContextChain & LiteSignUpChain,
    options: ReadLiteSignUpRequirementOptions & { tld: string },
): Promise<Result<LiteSignUpRequirement, ProductIndividualityError>>;
export async function readLiteSignUpRequirement(
    chain: GameChain & SignUpChain & AnyScoreContextChain & LiteSignUpChain,
    options: ReadLiteSignUpRequirementOptions,
): Promise<Result<LiteSignUpRequirement, ProductIndividualityError>> {
    try {
        const { account, liteMemberKey, signal } = options;
        if (liteMemberKey !== undefined && liteMemberKey.length !== LITE_MEMBER_KEY_BYTES) {
            throw new ProductIndividualityError(
                `lite member key must be ${LITE_MEMBER_KEY_BYTES} bytes`,
            );
        }

        const snapshot = await pinBlock(chain, signal);
        const at = readAt(snapshot, signal);
        const query = chain.individuality.query;

        const [{ requirement: game, player }, score, binding, litePerson, membership] =
            await Promise.all([
                runSignUpRequirementRead(
                    chain,
                    {
                        registrant: { tag: "Account", accountAddress: account },
                        keyType: options.keyType,
                        now: options.now,
                        signal,
                    },
                    snapshot,
                ),
                runScoreContextRead(chain, { signal, tld: options.tld }, snapshot),
                query.PeopleLite.AccountToAlias.getValue(account, at),
                query.PeopleLite.LitePeople.getValue(account, at),
                liteMemberKey === undefined
                    ? undefined
                    : query.Members.Members.getValue(
                          `0x${bytesToHex(ringCollectionId("people-lite"))}`,
                          `0x${bytesToHex(liteMemberKey)}`,
                          at,
                      ),
            ]);

        const liteBlockers: LiteSignUpBlocker[] = [];

        // Environment first: a context no host can mint stops both legs, and
        // naming it keeps a UI from sending the player to fix their binding.
        if (score.tag === "NotProductDerived") {
            liteBlockers.push({ tag: "ContextNotProductDerived" });
        }
        if (liteMemberKey !== undefined && membership?.type !== "Included") {
            liteBlockers.push({ tag: "NotLiteMember" });
        }
        if (player !== undefined && player.registered !== true) {
            liteBlockers.push({ tag: "AlreadyPlaying" });
        }

        // A lite person's own account can never hold a binding.
        if (litePerson !== undefined) {
            liteBlockers.push({ tag: "AccountIsALitePerson" });
        } else if (binding === undefined) {
            liteBlockers.push({ tag: "AliasNotBound" });
        } else if (normalizedHex(binding.ca.context) !== bytesToHex(score.context)) {
            liteBlockers.push({ tag: "AliasBoundElsewhere" });
        } else {
            const collection = `0x${bytesToHex(ringCollectionId("people-lite"))}`;
            const [invited, root] = await Promise.all([
                query.Game.LiteInvites.getValue(binding.ca.alias, at),
                query.Members.Root.getValue(collection, binding.ring, at),
            ]);
            if (root === undefined || root.revision !== binding.revision) {
                liteBlockers.push({ tag: "StaleAlias" });
            }
            if (invited !== undefined && !sameAccount(invited, account)) {
                liteBlockers.push({ tag: "AnotherAccountInvited", invited });
            }
        }

        return ok({
            ...game,
            canSignUp: game.canSignUp && liteBlockers.length === 0,
            canEnterDraws: game.canEnterDraws && liteBlockers.length === 0,
            blockers: [...game.blockers, ...liteBlockers],
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** Options for {@link signUpWithLiteInviteTx}. */
export interface SignUpWithLiteInviteOptions {
    /**
     * The account to sign up — a **call argument** here, unlike the account
     * sign-up where the signer implies it. It must also be the account that
     * signs the transaction: the extension resolves the alias from the signer,
     * and `LiteInvites` is checked against this argument.
     */
    account: string;
    /**
     * `CommunicationIdentifier`, exactly 65 bytes. Rewritten on every sign-up,
     * so pass the key whose private half the playing product holds now.
     */
    identifierKey: Uint8Array;
    /** Omit to enter no draw. Length must equal {@link airdropsScheduled}. */
    airdrops?: AccountVrfSignature[];
    /**
     * From {@link LiteSignUpRequirement}, checked against `airdrops` when both
     * are given — the same guard as the account sign-up, for the same reason.
     */
    airdropsScheduled?: number;
}

/**
 * Build `Game.sign_up_with_account_lite_invite`, unsigned. `Pays::No`, no
 * deposit, valid on a zero balance — but only submittable under
 * `withLiteAlias({ tag: "AliasWithAccount" })` by the bound account, with
 * `RestrictOrigins` true (which that signer sets).
 *
 * The same width and count guards as `signUpWithAccountTx`: they protect the
 * same call arguments, and the chain's own rejection names nothing local.
 *
 * @throws ProductIndividualityError on a wrong-width key or signature, or an
 *   airdrop count that disagrees with `airdropsScheduled`.
 */
export function signUpWithLiteInviteTx<Tx>(
    chain: LiteSignUpChain<Tx>,
    options: SignUpWithLiteInviteOptions,
): Tx {
    return chain.individuality.tx.Game.sign_up_with_account_lite_invite({
        account: options.account,
        identifier_key: identifierKeyHex(options.identifierKey),
        airdrops: accountAirdropsArg(options),
    });
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapOk, unwrapErr } = await import("@parity/result");

    const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    const BASE = "pop:game:airdrop:          ";
    const IDENTIFIER = new Uint8Array(65).fill(0x22);
    const MEMBER_KEY = new Uint8Array(32).fill(0x77);
    const ALIAS = `0x${"ee".repeat(32)}`;

    /** Previewnet's published `Score.score_context` (spec 1000036) for `peopl.test`. */
    const SCORE_CONTEXT = "0xa02ef8d90148203d1b7573e28c044c7b46e42793766bf6d7687ef5da86024a8e";
    /** A context that is valid hex but not the product derivation (the nextv2 shape). */
    const LITERAL_CONTEXT = `0x${Array.from("pop:polkadot.network/score      ", (c) =>
        c.charCodeAt(0).toString(16).padStart(2, "0"),
    ).join("")}`;

    const BLOCK_HASH = `0x${"aa".repeat(32)}`;

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

    const BOUND = {
        revision: 5,
        ring: 2,
        ca: { alias: ALIAS, context: SCORE_CONTEXT },
    };

    type LiteChain = GameChain &
        SignUpChain &
        ScoreContextChain &
        LegacySuffixChain &
        LiteSignUpChain;
    type SuffixlessLiteChain = GameChain & SignUpChain & ScoreContextChain & LiteSignUpChain;

    function fakeChain(
        overrides: {
            game?: unknown;
            participant?: unknown;
            player?: unknown;
            scoreContext?: string;
            binding?: RawLiteAliasBinding;
            litePerson?: unknown;
            membership?: RawLiteRingMembership;
            invited?: string;
            root?: { revision: number };
            noSuffix?: boolean;
        } = {},
    ) {
        const calls: {
            tx: unknown[];
            keys: Record<string, unknown>;
            at: Record<string, unknown>;
        } = { tx: [], keys: {}, at: {} };
        const chain = {
            raw: {
                individuality: {
                    getFinalizedBlock: async () => ({ hash: BLOCK_HASH, number: 42 }),
                },
            },
            individuality: {
                constants: {
                    Game: {
                        airdrop_event_id_base: async () => BASE,
                        DefaultPhaseDurations: async () => DURATIONS,
                    },
                    Score: {
                        score_context: async () => overrides.scoreContext ?? SCORE_CONTEXT,
                        ...(overrides.noSuffix === true
                            ? {}
                            : { Suffix: async () => new TextEncoder().encode("test") }),
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
                        Players: {
                            getValue: async (key: unknown, options: unknown) => {
                                calls.keys.players = key;
                                calls.at.players = options;
                                return overrides.player;
                            },
                        },
                        LiteInvites: {
                            getValue: async (key: unknown, options: unknown) => {
                                calls.keys.liteInvites = key;
                                calls.at.liteInvites = options;
                                return overrides.invited;
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
                    PeopleLite: {
                        AccountToAlias: {
                            getValue: async (key: unknown, options: unknown) => {
                                calls.keys.accountToAlias = key;
                                calls.at.accountToAlias = options;
                                return overrides.binding;
                            },
                        },
                        LitePeople: {
                            getValue: async (key: unknown) => {
                                calls.keys.litePeople = key;
                                return overrides.litePerson;
                            },
                        },
                    },
                    Members: {
                        Members: {
                            getValue: async (
                                collection: unknown,
                                key: unknown,
                                options: unknown,
                            ) => {
                                calls.keys.membersCollection = collection;
                                calls.keys.membersKey = key;
                                calls.at.members = options;
                                return overrides.membership;
                            },
                        },
                        Root: {
                            getValue: async (
                                collection: unknown,
                                ring: unknown,
                                options: unknown,
                            ) => {
                                calls.keys.rootCollection = collection;
                                calls.keys.rootRing = ring;
                                calls.at.root = options;
                                return "root" in overrides
                                    ? overrides.root
                                    : { revision: BOUND.revision };
                            },
                        },
                    },
                },
                tx: {
                    Game: {
                        sign_up_with_account_lite_invite: (args: unknown) => {
                            calls.tx.push(args);
                            return args;
                        },
                    },
                },
            },
        };
        return { chain: chain as unknown as LiteChain, calls };
    }

    describe("readLiteSignUpRequirement", () => {
        test("a bound, invited-here lite account in registration can sign up", async () => {
            const { chain } = fakeChain({
                binding: BOUND,
                invited: ACCOUNT,
                membership: { type: "Included" },
            });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, {
                    account: ACCOUNT,
                    liteMemberKey: MEMBER_KEY,
                    now: 1_000,
                }),
            );

            expect(value.canSignUp).toBe(true);
            expect(value.canEnterDraws).toBe(true);
            expect(value.blockers).toEqual([]);
            // The account-path shape carries through untouched.
            expect(value.gameIndex).toBe(7);
            expect(value.variant).toBe("Account");
            expect(value.airdropsScheduled).toBe(2);
            expect(value.eventIds).toHaveLength(2);
        });

        test("no invite pin yet is the first sign-up, not a blocker", async () => {
            // `LiteInvites[alias]` is written by the sign-up itself, so its
            // absence is exactly the state a fresh lite person is in.
            const { chain } = fakeChain({ binding: BOUND });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(true);
            expect(value.blockers).toEqual([]);
        });

        test.each([
            ["an existing unregistered player", { registered: false }, ["AlreadyPlaying"]],
            ["an archived player, no entry at all", undefined, []],
        ])("%s: the invited call is right only before the first game", async (_, player, tags) => {
            // sign_up_inner rejects an invited sign-up before it reads `registered`.
            const { chain } = fakeChain({ binding: BOUND, invited: ACCOUNT, player });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.blockers.map((blocker) => blocker.tag)).toEqual(tags);
        });

        test("a registered player is AlreadyRegistered, not AlreadyPlaying", async () => {
            // The account read's arm is the better message for the running game.
            const { chain } = fakeChain({
                binding: BOUND,
                invited: ACCOUNT,
                player: { registered: true },
            });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.blockers.map((blocker) => blocker.tag)).toEqual(["AlreadyRegistered"]);
        });

        test.each([
            ["a matching revision", { revision: BOUND.revision }, []],
            ["a newer ring revision", { revision: BOUND.revision + 1 }, ["StaleAlias"]],
            ["no ring root at all", undefined, ["StaleAlias"]],
        ])("%s", async (_, root, tags) => {
            const { chain, calls } = fakeChain({ binding: BOUND, invited: ACCOUNT, root });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.blockers.map((blocker) => blocker.tag)).toEqual(tags);
            expect(calls.keys.rootRing).toBe(BOUND.ring);
        });

        test("the invite pin is compared by public key, not by SS58 spelling", async () => {
            // A string compare would block a sign-up the chain would accept.
            const prefixed = AccountId(2).dec(AccountId().enc(ACCOUNT));
            expect(prefixed).not.toBe(ACCOUNT);
            const { chain } = fakeChain({ binding: BOUND, invited: prefixed });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.blockers).toEqual([]);
            expect(value.canSignUp).toBe(true);
        });

        test("a chain publishing no suffix answers when the caller supplies the tld", async () => {
            // Paseo's shape since individuality-community#20 dropped the constant.
            const { chain } = fakeChain({ binding: BOUND, invited: ACCOUNT, noSuffix: true });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain as unknown as SuffixlessLiteChain, {
                    account: ACCOUNT,
                    now: 1_000,
                    tld: "test",
                }),
            );

            expect(value.blockers).toEqual([]);
            expect(value.canSignUp).toBe(true);
        });

        test("a wrong tld derives a context the chain does not publish", async () => {
            const { chain } = fakeChain({ binding: BOUND, invited: ACCOUNT, noSuffix: true });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain as unknown as SuffixlessLiteChain, {
                    account: ACCOUNT,
                    now: 1_000,
                    tld: "paseo",
                }),
            );

            expect(value.blockers).toEqual([{ tag: "ContextNotProductDerived" }]);
        });

        test("an unbound account reports AliasNotBound and skips the invite read", async () => {
            // The invite pin is keyed by the alias, which only the binding names.
            const { chain, calls } = fakeChain();
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.canEnterDraws).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AliasNotBound" }]);
            expect(calls.keys.liteInvites).toBeUndefined();
        });

        test("a binding outside the score context is AliasBoundElsewhere", async () => {
            const { chain, calls } = fakeChain({
                binding: { ...BOUND, ca: { alias: ALIAS, context: `0x${"99".repeat(32)}` } },
            });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AliasBoundElsewhere" }]);
            expect(calls.keys.liteInvites).toBeUndefined();
        });

        test("a context compared case-insensitively is still the same context", async () => {
            const { chain } = fakeChain({
                binding: {
                    ...BOUND,
                    ca: { alias: ALIAS, context: `0x${SCORE_CONTEXT.slice(2).toUpperCase()}` },
                },
                invited: ACCOUNT,
            });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );
            expect(value.blockers).toEqual([]);
        });

        test("an invite pinned to another account names that account", async () => {
            // `LiteInvites` is forever: the UI must show which seat is taken.
            const { chain } = fakeChain({ binding: BOUND, invited: OTHER });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AnotherAccountInvited", invited: OTHER }]);
        });

        test("an account that is itself a lite person blocks alone", async () => {
            const { chain } = fakeChain({ litePerson: { method: "whatever" } });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AccountIsALitePerson" }]);
        });

        test.each([{ type: "Onboarding" }, { type: "Suspended" }, undefined])(
            "a member key whose entry is %o is NotLiteMember",
            async (membership) => {
                const { chain } = fakeChain({ binding: BOUND, invited: ACCOUNT, membership });
                const value = unwrapOk(
                    await readLiteSignUpRequirement(chain, {
                        account: ACCOUNT,
                        liteMemberKey: MEMBER_KEY,
                        now: 1_000,
                    }),
                );

                expect(value.canSignUp).toBe(false);
                expect(value.blockers).toEqual([{ tag: "NotLiteMember" }]);
            },
        );

        test("no member key skips the membership read entirely", async () => {
            const { chain, calls } = fakeChain({ binding: BOUND, invited: ACCOUNT });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.blockers).toEqual([]);
            expect(calls.keys.membersKey).toBeUndefined();
        });

        test("a wrong-width member key is an error, not a NotLiteMember answer", async () => {
            // 31 bytes is a caller bug; reporting it as "not a member" would
            // send the player to prove personhood they may already have.
            const { chain } = fakeChain({ binding: BOUND });
            const result = await readLiteSignUpRequirement(chain, {
                account: ACCOUNT,
                liteMemberKey: new Uint8Array(31),
                now: 1_000,
            });
            expect(unwrapErr(result)).toBeInstanceOf(ProductIndividualityError);
        });

        test("a literal score context is ContextNotProductDerived, on the ok channel", async () => {
            // The nextv2 state: the constant exists, but no stock host can mint
            // a proof in it. The binding comparison still runs against the
            // published constant, so a matching binding adds no second blocker.
            const { chain } = fakeChain({
                scoreContext: LITERAL_CONTEXT,
                binding: { ...BOUND, ca: { alias: ALIAS, context: LITERAL_CONTEXT } },
                invited: ACCOUNT,
            });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.blockers).toEqual([{ tag: "ContextNotProductDerived" }]);
        });

        test("account-path blockers carry through next to the lite ones", async () => {
            const { chain } = fakeChain({ player: { registered: true } });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.blockers).toEqual([
                { tag: "AlreadyRegistered" },
                { tag: "AliasNotBound" },
            ]);
        });

        test("the draw-only split survives: lite-clear but recognized blocks draws only", async () => {
            const { chain } = fakeChain({
                binding: BOUND,
                invited: ACCOUNT,
                participant: {
                    score: 10,
                    streak: { type: "Attended", value: 1 },
                    attendance_history: 1,
                    reached_personhood: true,
                    recognition: { type: "Recognized", value: `0x${"cc".repeat(32)}` },
                    last_attended_game: 6,
                },
            });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(true);
            expect(value.canEnterDraws).toBe(false);
            expect(value.blockers).toEqual([{ tag: "AliasVrfsUnavailable" }]);
        });

        test("a lite blocker also stops the draws: they ride on the sign-up", async () => {
            const { chain } = fakeChain({ binding: BOUND, invited: OTHER });
            const value = unwrapOk(
                await readLiteSignUpRequirement(chain, { account: ACCOUNT, now: 1_000 }),
            );

            expect(value.canSignUp).toBe(false);
            expect(value.canEnterDraws).toBe(false);
        });

        test("keys every read as documented, all at the one pinned block", async () => {
            const { chain, calls } = fakeChain({
                binding: BOUND,
                invited: ACCOUNT,
                membership: { type: "Included" },
            });
            await readLiteSignUpRequirement(chain, {
                account: ACCOUNT,
                liteMemberKey: MEMBER_KEY,
                now: 1_000,
            });

            expect(calls.keys.accountToAlias).toBe(ACCOUNT);
            expect(calls.keys.litePeople).toBe(ACCOUNT);
            expect(calls.keys.liteInvites).toBe(ALIAS);
            // The account path is keyed by this account, not by an alias.
            expect(calls.keys.players).toEqual({ type: "Account", value: ACCOUNT });
            expect(calls.keys.participants).toEqual({ type: "Account", value: ACCOUNT });
            // The lite ring's space-padded collection id, and the key as hex.
            expect(calls.keys.membersCollection).toBe(
                "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652d6c697465",
            );
            expect(calls.keys.membersKey).toBe(`0x${"77".repeat(32)}`);
            for (const options of Object.values(calls.at)) {
                expect((options as { at: string }).at).toBe(BLOCK_HASH);
            }
        });

        test("a failing read arrives as the package error", async () => {
            const { chain } = fakeChain();
            chain.individuality.query.PeopleLite.AccountToAlias.getValue = () =>
                Promise.reject(new Error("node unreachable"));
            const result = await readLiteSignUpRequirement(chain, {
                account: ACCOUNT,
                now: 1_000,
            });
            expect(unwrapErr(result)).toBeInstanceOf(ProductIndividualityError);
        });

        test("an aborted signal answers before any round trip", async () => {
            const controller = new AbortController();
            controller.abort();
            const { chain, calls } = fakeChain();
            const result = await readLiteSignUpRequirement(chain, {
                account: ACCOUNT,
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
            expect(calls.keys.accountToAlias).toBeUndefined();
        });
    });

    describe("signUpWithLiteInviteTx", () => {
        test("carries the account and omits airdrops entirely when none are given", () => {
            const { chain, calls } = fakeChain();
            signUpWithLiteInviteTx(chain, { account: ACCOUNT, identifierKey: IDENTIFIER });

            expect(calls.tx[0]).toEqual({
                account: ACCOUNT,
                identifier_key: `0x${"22".repeat(65)}`,
                airdrops: undefined,
            });
        });

        test("wraps the signatures in the Account variant, hex-encoded", () => {
            const { chain, calls } = fakeChain();
            signUpWithLiteInviteTx(chain, {
                account: ACCOUNT,
                identifierKey: IDENTIFIER,
                airdrops: [
                    {
                        preOutput: new Uint8Array(32).fill(0xaa),
                        proof: new Uint8Array(64).fill(0xbb),
                    },
                ],
            });

            expect(calls.tx[0]).toEqual({
                account: ACCOUNT,
                identifier_key: `0x${"22".repeat(65)}`,
                airdrops: {
                    type: "Account",
                    value: [{ pre_output: `0x${"aa".repeat(32)}`, proof: `0x${"bb".repeat(64)}` }],
                },
            });
        });

        test("rejects the same widths and count mismatches as the account sign-up", () => {
            const { chain } = fakeChain();
            const one = [{ preOutput: new Uint8Array(32), proof: new Uint8Array(64) }];

            expect(() =>
                signUpWithLiteInviteTx(chain, {
                    account: ACCOUNT,
                    identifierKey: new Uint8Array(64),
                }),
            ).toThrow(ProductIndividualityError);
            expect(() =>
                signUpWithLiteInviteTx(chain, {
                    account: ACCOUNT,
                    identifierKey: IDENTIFIER,
                    airdrops: one,
                    airdropsScheduled: 2,
                }),
            ).toThrow(ProductIndividualityError);
            expect(() =>
                signUpWithLiteInviteTx(chain, {
                    account: ACCOUNT,
                    identifierKey: IDENTIFIER,
                    airdrops: [{ preOutput: new Uint8Array(31), proof: new Uint8Array(64) }],
                }),
            ).toThrow(ProductIndividualityError);
            expect(() =>
                signUpWithLiteInviteTx(chain, {
                    account: ACCOUNT,
                    identifierKey: IDENTIFIER,
                    airdrops: one,
                    airdropsScheduled: 1,
                }),
            ).not.toThrow();
        });
    });
}
