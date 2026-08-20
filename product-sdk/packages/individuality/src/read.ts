// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The pinned read: a username or an account in, one {@link PersonhoodResult} out.
 *
 * **Every read shares one finalized block.** Two of the six values move on a
 * session cadence (`Score.PersonhoodThreshold` and `Score.AbsenceGraceRatio`
 * both have schedules behind them), so reading them at different blocks would
 * silently mix eras. The block is pinned once and reported on the result.
 *
 * This module resolves no chain of its own. It takes an already-connected
 * client, which is what keeps chain selection — and the environment question —
 * with the caller:
 *
 * ```ts
 * const chain = await getChainAPI("paseo");
 * const state = await readPersonhoodState(chain, { username: "alice.dot" });
 *
 * // Or, when the account is already in hand:
 * const same = await readPersonhoodState(chain, { account: aliceAddress });
 * ```
 */
import { Enum } from "polkadot-api";
import { err, normalizeError, ok, type Result } from "@parity/result";
import { derivePersonhoodState, missesInWindow } from "./derive.js";
import {
    decodeAbsenceGracePolicy,
    toPersonhoodParticipant,
    type RawParticipant,
} from "./decode.js";
import { ProductIndividualityError } from "./errors.js";
import type {
    FinalizedSnapshot,
    PersonhoodMetrics,
    PersonhoodParticipant,
    PersonhoodResult,
} from "./types.js";

/** Options every storage read is given, so all six agree on one block. */
interface ReadAt {
    at: string;
    signal?: AbortSignal;
}

/** `AccountToAlias`, narrowed to the contextual alias the read keys on. */
export interface RawAccountAlias {
    ca: { alias: string };
}

/**
 * The chain surface this read needs — deliberately structural, not a pinned
 * descriptor.
 *
 * Anything exposing these six entries satisfies it: a real
 * `ChainClient<{ individuality: … }>` from `getChainAPI`, a future People Lite
 * deployment, or a hand-rolled test double. The same approach as
 * `PeopleUsernameQueryApi` in `@parity/product-sdk`'s `identity/dotns.ts`, and
 * for the same reason — the SDK should not pin a genesis hash to read a
 * username.
 *
 * Written with method shorthand on purpose: the parameter bivariance that gives
 * is what lets the real PAPI signatures satisfy the loosened key types below.
 *
 * **Fidelity is checked at compile time, from the umbrella package.**
 * `packages/sdk/src/individuality/contract.test.ts` asserts that a real
 * `getChainAPI` client still satisfies this type, so a descriptor regeneration
 * that changes an entry fails `pnpm typecheck`.
 *
 * The guard has to live there rather than here, which is worth recording because
 * it is not obvious. Inside this package the same assertion is *vacuous*: it
 * passes even against a contract demanding a pallet the chain does not have,
 * because the descriptor types do not fully resolve through this package's
 * dependency graph. From `packages/sdk`, which depends on both `chain-client` and
 * this package, the identical assertion correctly rejects a bogus contract. Both
 * halves were verified before choosing the placement.
 *
 * The entries were also matched by hand on 2026-08-17 against
 * `descriptors/chains/paseo-individuality/generated/dist/paseo_individuality.d.ts`:
 *
 * ```
 * UsernameOwnerOf:      StorageDescriptor<[Key: Uint8Array], SS58String, true, never>
 * Participants:         key AnonymousEnum<{ Account: SS58String; Person: SizedHex<32> }>
 * PersonhoodThreshold:  StorageDescriptor<[], number, false, never>
 * AbsenceGraceRatio:    StorageDescriptor<[], SizedHex<2>, false, never>
 * AccountToAlias:       value { revision, ring, ca: { alias, context } }
 * LitePeople:           value { ring_vrf_key, method }        (presence is the signal)
 * ```
 *
 * A descriptor regeneration that changes any of them now fails `pnpm typecheck`
 * rather than passing silently.
 */
export interface IndividualityChain {
    individuality: {
        query: {
            Resources: {
                UsernameOwnerOf: {
                    getValue(key: Uint8Array, options: ReadAt): Promise<string | undefined>;
                };
            };
            Score: {
                Participants: {
                    getValue(
                        key: { type: string; value: unknown },
                        options: ReadAt,
                    ): Promise<RawParticipant | undefined>;
                };
                PersonhoodThreshold: {
                    getValue(options: ReadAt): Promise<number>;
                };
                AbsenceGraceRatio: {
                    getValue(options: ReadAt): Promise<string>;
                };
            };
            People: {
                AccountToAlias: {
                    getValue(key: string, options: ReadAt): Promise<RawAccountAlias | undefined>;
                };
            };
            PeopleLite: {
                LitePeople: {
                    getValue(key: string, options: ReadAt): Promise<unknown>;
                };
                /**
                 * Read as well as `People.AccountToAlias`: a Lite person's alias
                 * lives here, and without it the alias-keyed participant lookup
                 * never runs for them.
                 */
                AccountToAlias: {
                    getValue(key: string, options: ReadAt): Promise<RawAccountAlias | undefined>;
                };
            };
        };
    };
    raw: {
        individuality: {
            getFinalizedBlock(): Promise<{ hash: string; number: number }>;
        };
    };
}

/**
 * What to read, and how: a username or an account, and never both.
 *
 * Two inputs rather than one because a profile or results screen usually holds
 * an account, not a name, and making it look the name up first would be a read
 * this function then throws away.
 *
 * **The rule is enforced at runtime, not by this type.** The union below rejects
 * an object literal that names both fields as strings, and rejects an empty one.
 * It does not reject `{ username: maybeName, account: maybeAccount }` with both
 * typed `string | undefined`, which is the shape a caller writes when the values
 * come from state: TypeScript checks such a literal property by property against
 * the union and lets it through. {@link selectInput} is what actually holds the
 * rule, and an ambiguous call is an `err` result rather than a silent choice.
 */
export type ReadPersonhoodStateOptions = {
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the
     * whole batch. No deadline is applied here — that belongs to the caller, or
     * eventually to `chain-client`.
     */
    signal?: AbortSignal;
} & (
    | {
          /**
           * The DotNS username, UTF-8 encoded as-is with no normalization. Pass
           * the exact byte string the chain stores, TLD suffix included — which
           * is `.dot` on mainnet, but not on every network.
           */
          username: string;
          account?: never;
      }
    | {
          /**
           * The account whose standing to read, SS58-encoded as the chain
           * stores it. Skips the username lookup entirely, so `UsernameUnowned`
           * is unreachable on this path.
           */
          account: string;
          username?: never;
      }
);

/**
 * Read a person's personhood state from one pinned finalized block.
 *
 * Takes a DotNS username or an account address. Every resolved answer carries
 * both the derived state and the {@link PersonhoodMetrics} it came from, so a
 * caller rendering progress does not have to switch on the state to find a
 * score.
 *
 * Returns a `Result`, per the SDK-wide error model: `ok` carries the answer,
 * `err` carries a {@link ProductIndividualityError}. Everything that can go
 * wrong arrives on the `err` channel, not only decode failures. That includes an
 * unreachable node, an aborted signal, and the pinned block leaving the
 * follower's window mid-read, each normalized into the package's error type with
 * the original cause attached.
 *
 * A username nobody owns is **not** a failure. It resolves to
 * `ok({ tag: "UsernameUnowned", ... })`, because the chain was asked and
 * answered. An account input never lands there: nothing was looked up, so
 * an account with no records resolves to `NotEnrolled` instead.
 *
 * **Not an authorization oracle.** This is a client-side read in a client-side
 * library, and a backend that trusts "the SDK said `Member`" is trivially
 * spoofed.
 */
export async function readPersonhoodState(
    chain: IndividualityChain,
    options: ReadPersonhoodStateOptions,
): Promise<Result<PersonhoodResult, ProductIndividualityError>> {
    try {
        return ok(await runRead(chain, options));
    } catch (cause) {
        // Every failure lands here: decode errors thrown by the mappers, the
        // early abort in runRead, and any transport rejection from a pull.
        // normalizeError passes an existing package error through unchanged, so
        // callers can still narrow with isErrorOf.
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** The one input a read runs on, chosen and validated before any round trip. */
type ReadInput = { by: "account"; account: string } | { by: "username"; username: string };

/**
 * Pick the single input, or throw.
 *
 * Called before the block is pinned, so a call that cannot succeed costs no
 * round trip.
 *
 * An empty string counts as absent, and so does anything that is not a string.
 * Taken as input, `""` resolves to a confident answer about the empty account.
 */
function selectInput(options: ReadPersonhoodStateOptions): ReadInput {
    const given = (value: unknown): string | undefined =>
        typeof value === "string" && value.length > 0 ? value : undefined;
    const account = given(options.account);
    const username = given(options.username);
    if (account !== undefined && username !== undefined) {
        throw new ProductIndividualityError(
            "readPersonhoodState takes a username or an account, not both",
        );
    }
    if (account !== undefined) {
        return { by: "account", account };
    }
    if (username !== undefined) {
        return { by: "username", username };
    }
    throw new ProductIndividualityError("readPersonhoodState needs a username or an account");
}

/** The read itself. Throws; {@link readPersonhoodState} owns the Result boundary. */
async function runRead(
    chain: IndividualityChain,
    options: ReadPersonhoodStateOptions,
): Promise<PersonhoodResult> {
    const { signal } = options;
    const query = chain.individuality.query;

    // Neither an unusable call nor an already cancelled one should pin a block. The
    // fetch below takes no options, so it cannot carry the signal itself.
    const input = selectInput(options);
    signal?.throwIfAborted();

    // Pin one finalized block: every read below must agree on it.
    const block = await chain.raw.individuality.getFinalizedBlock();
    const at: ReadAt = { at: block.hash, signal };
    const snapshot: FinalizedSnapshot = { blockHash: block.hash, blockNumber: block.number };

    // An account input *skips* the username lookup rather than adding a read to
    // it, which is why the account path costs one round trip less.
    let owner: string;
    if (input.by === "account") {
        owner = input.account;
    } else {
        // The entry point is `Resources.UsernameOwnerOf` on the individuality
        // chain's resources pallet — not `pallet_identity` on the fellows People
        // chain. Those are unrelated username systems.
        const resolved = await query.Resources.UsernameOwnerOf.getValue(
            new TextEncoder().encode(input.username),
            at,
        );
        if (resolved == null) {
            return { tag: "UsernameUnowned", at: snapshot };
        }
        owner = resolved;
    }

    const [
        accountParticipant,
        peopleAlias,
        liteAlias,
        litePerson,
        personhoodThreshold,
        absenceGraceRatio,
    ] = await Promise.all([
        query.Score.Participants.getValue(Enum("Account", owner), at),
        query.People.AccountToAlias.getValue(owner, at),
        query.PeopleLite.AccountToAlias.getValue(owner, at),
        query.PeopleLite.LitePeople.getValue(owner, at),
        // `PersonhoodThreshold` is a u8. PAPI types both u8 and u32 as
        // number, so a width mistake typechecks and passes tests.
        query.Score.PersonhoodThreshold.getValue(at),
        query.Score.AbsenceGraceRatio.getValue(at),
    ]);

    // Both pallets carry an `AccountToAlias` with the same value shape. The Lite
    // signal comes from `PeopleLite`, so its alias has to be consulted too, or a
    // Lite person's alias-keyed record is invisible. `People` wins when both hold
    // one, since a full person's alias is the more specific answer.
    const alias = peopleAlias ?? liteAlias;

    // No account-keyed record: fall back to the contextual alias key. The
    // account key is tried first because `Score.Participants` is keyed by an
    // enum, so one lookup cannot cover both.
    const rawParticipant =
        accountParticipant ??
        (alias == null
            ? null
            : await query.Score.Participants.getValue(Enum("Person", alias.ca.alias), at));

    const participant: PersonhoodParticipant | null =
        rawParticipant == null ? null : toPersonhoodParticipant(rawParticipant);

    const policy = decodeAbsenceGracePolicy(absenceGraceRatio);

    // `misses` is what the window holds now, not `Caution.misses`, which is what
    // one more absence would leave in it.
    const metrics: PersonhoodMetrics = {
        score: participant?.score ?? null,
        personhoodThreshold,
        misses:
            participant == null
                ? null
                : missesInWindow(participant.attendanceHistory, policy.window),
        allowedMisses: policy.allowedMisses,
        window: policy.window,
    };

    return {
        tag: "Resolved",
        at: snapshot,
        accountAddress: owner,
        // The Person key is the contextual alias, never the DotNS text.
        alias: alias?.ca.alias ?? null,
        state: derivePersonhoodState({
            // Presence is the Lite signal, not `Resources.Consumers().credibility`.
            isLitePerson: litePerson != null,
            participant,
            personhoodThreshold,
            policy,
        }),
        metrics,
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { unwrapOk, unwrapErr, isErrorOf } = await import("@parity/result");
    const { IndividualityDecodeError } = await import("./errors.js");

    const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    const ALIAS = `0x${"ab".repeat(32)}`;
    const LITE_ALIAS = `0x${"cd".repeat(32)}`;
    const BLOCK = { hash: `0x${"11".repeat(32)}`, number: 5_000 };

    /** The key a recorded read was addressed with, by storage entry. */
    const keyOfIn = (calls: Array<{ entry: string; key: unknown }>, entry: string): unknown =>
        calls.find((c) => c.entry === entry)?.key;

    const raw = (overrides: Partial<RawParticipant> = {}): RawParticipant => ({
        score: 7,
        streak: { type: "Attended", value: 4 },
        attendance_history: 0xff,
        reached_personhood: true,
        recognition: { type: "Recognized", value: 5n },
        last_attended_game: 42,
        ...overrides,
    });

    interface FakeState {
        owner?: string;
        accountParticipant?: RawParticipant;
        personParticipant?: RawParticipant;
        alias?: RawAccountAlias;
        liteAlias?: RawAccountAlias;
        lite?: unknown;
        threshold?: number;
        grace?: string;
    }

    /**
     * A chain double that records the key and the options every read was given.
     *
     * The key is recorded deliberately: without it, a read addressed with the
     * wrong key still satisfies every other assertion here.
     */
    function fakeChain(state: FakeState) {
        const calls: Array<{
            entry: string;
            key: unknown;
            at: string;
            signal?: AbortSignal;
        }> = [];
        // Separate from `calls`: the block fetch takes no key and no options.
        let blockFetches = 0;
        const record = (entry: string, key: unknown, options: ReadAt) => {
            calls.push({ entry, key, at: options.at, signal: options.signal });
        };
        const keyOf = (entry: string) => keyOfIn(calls, entry);
        const chain: IndividualityChain = {
            individuality: {
                query: {
                    Resources: {
                        UsernameOwnerOf: {
                            async getValue(key, options) {
                                record("UsernameOwnerOf", key, options);
                                return state.owner;
                            },
                        },
                    },
                    Score: {
                        Participants: {
                            async getValue(key, options) {
                                record(`Participants:${key.type}`, key, options);
                                return key.type === "Account"
                                    ? state.accountParticipant
                                    : state.personParticipant;
                            },
                        },
                        PersonhoodThreshold: {
                            async getValue(options) {
                                record("PersonhoodThreshold", undefined, options);
                                return state.threshold ?? 5;
                            },
                        },
                        AbsenceGraceRatio: {
                            async getValue(options) {
                                record("AbsenceGraceRatio", undefined, options);
                                return state.grace ?? "0x0108";
                            },
                        },
                    },
                    People: {
                        AccountToAlias: {
                            async getValue(key, options) {
                                record("AccountToAlias", key, options);
                                return state.alias;
                            },
                        },
                    },
                    PeopleLite: {
                        LitePeople: {
                            async getValue(key, options) {
                                record("LitePeople", key, options);
                                return state.lite;
                            },
                        },
                        AccountToAlias: {
                            async getValue(key, options) {
                                record("LiteAccountToAlias", key, options);
                                return state.liteAlias;
                            },
                        },
                    },
                },
            },
            raw: {
                individuality: {
                    async getFinalizedBlock() {
                        blockFetches += 1;
                        return BLOCK;
                    },
                },
            },
        };
        return { chain, calls, keyOf, blockFetches: () => blockFetches };
    }

    describe("readPersonhoodState", () => {
        test("an unowned username is a success value, and stops after one read", async () => {
            const { chain, calls } = fakeChain({ owner: undefined });
            const result = await readPersonhoodState(chain, { username: "nobody.dot" });
            expect(unwrapOk(result)).toEqual({
                tag: "UsernameUnowned",
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
            });
            // The batch must not run once the username is unowned.
            expect(calls.map((c) => c.entry)).toEqual(["UsernameOwnerOf"]);
        });

        test("the username is UTF-8 encoded, not passed through", async () => {
            const { chain, keyOf } = fakeChain({ owner: ALICE });
            await readPersonhoodState(chain, { username: "alice.dot" });
            expect(keyOf("UsernameOwnerOf")).toEqual(new TextEncoder().encode("alice.dot"));
        });

        test("every account-keyed read uses the owner, not the username", async () => {
            const { chain, keyOf } = fakeChain({ owner: ALICE });
            await readPersonhoodState(chain, { username: "alice.dot" });
            expect(keyOf("Participants:Account")).toEqual(Enum("Account", ALICE));
            expect(keyOf("AccountToAlias")).toBe(ALICE);
            expect(keyOf("LiteAccountToAlias")).toBe(ALICE);
            expect(keyOf("LitePeople")).toBe(ALICE);
        });

        test("resolves an account-keyed participant without the alias fallback", async () => {
            // The alias is present on purpose: skipping the Person read must be
            // because the account key hit, not because there was nothing to fall
            // back to.
            const { chain, calls } = fakeChain({
                owner: ALICE,
                accountParticipant: raw(),
                alias: { ca: { alias: ALIAS } },
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                tag: "Resolved",
                accountAddress: ALICE,
                state: { tag: "Member", activeWeeks: 4, lastAttendedGame: 42 },
            });
            expect(calls.filter((c) => c.entry.startsWith("Participants:"))).toHaveLength(1);
            expect(calls.some((c) => c.entry === "Participants:Person")).toBe(false);
        });

        test("the account-keyed record wins when both keys hold one", async () => {
            // Reversing the ?? chain changes which record wins, and nothing else
            // here notices. Score 7 is the account record, 99 the alias one.
            const { chain } = fakeChain({
                owner: ALICE,
                accountParticipant: raw({
                    score: 7,
                    recognition: { type: "NotRecognized" },
                    reached_personhood: false,
                }),
                alias: { ca: { alias: ALIAS } },
                personParticipant: raw({
                    score: 99,
                    recognition: { type: "NotRecognized" },
                    reached_personhood: false,
                }),
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                state: { tag: "Candidate", score: 7 },
            });
        });

        test("falls back to the alias key when no account-keyed record exists", async () => {
            const { chain, calls, keyOf } = fakeChain({
                owner: ALICE,
                accountParticipant: undefined,
                alias: { ca: { alias: ALIAS } },
                personParticipant: raw({ score: 3, recognition: { type: "NotRecognized" } }),
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                tag: "Resolved",
                alias: ALIAS,
                state: { tag: "MembershipReady" },
            });
            // Account key first, then the Person key. Order matters.
            expect(
                calls.filter((c) => c.entry.startsWith("Participants:")).map((c) => c.entry),
            ).toEqual(["Participants:Account", "Participants:Person"]);
            // The Person key is the contextual alias, never the owner or the username.
            expect(keyOf("Participants:Person")).toEqual(Enum("Person", ALIAS));
        });

        test("a Lite person's alias comes from PeopleLite when People has none", async () => {
            // Without reading PeopleLite.AccountToAlias this person reports Lite,
            // because the alias-keyed lookup never runs.
            const { chain, keyOf } = fakeChain({
                owner: ALICE,
                alias: undefined,
                liteAlias: { ca: { alias: LITE_ALIAS } },
                lite: { ring_vrf_key: "0x00" },
                personParticipant: raw({ score: 4, recognition: { type: "NotRecognized" } }),
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                alias: LITE_ALIAS,
                state: { tag: "MembershipReady" },
            });
            expect(keyOf("Participants:Person")).toEqual(Enum("Person", LITE_ALIAS));
        });

        test("the People alias wins over the PeopleLite one", async () => {
            const { chain } = fakeChain({
                owner: ALICE,
                alias: { ca: { alias: ALIAS } },
                liteAlias: { ca: { alias: LITE_ALIAS } },
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({ alias: ALIAS });
        });

        test("skips the fallback entirely when neither pallet has an alias", async () => {
            const { chain, calls } = fakeChain({ owner: ALICE, alias: undefined });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                tag: "Resolved",
                alias: null,
                state: { tag: "NotEnrolled" },
            });
            expect(calls.some((c) => c.entry === "Participants:Person")).toBe(false);
        });

        test("all reads share one pinned finalized block", async () => {
            // The whole point of the function. Two of the values move on a session
            // cadence, so a second block here would mix eras silently.
            const { chain, calls } = fakeChain({
                owner: ALICE,
                alias: { ca: { alias: ALIAS } },
                personParticipant: raw(),
            });
            await readPersonhoodState(chain, { username: "alice.dot" });
            expect(calls).toHaveLength(8); // 1 owner + 6 batch + 1 alias fallback
            expect(new Set(calls.map((c) => c.at))).toEqual(new Set([BLOCK.hash]));
        });

        test("forwards the abort signal into every read", async () => {
            const controller = new AbortController();
            const { chain, calls } = fakeChain({ owner: ALICE, accountParticipant: raw() });
            await readPersonhoodState(chain, {
                username: "alice.dot",
                signal: controller.signal,
            });
            expect(calls).toHaveLength(7);
            expect(calls.every((c) => c.signal === controller.signal)).toBe(true);
        });

        test("an already cancelled read costs no round trip", async () => {
            const controller = new AbortController();
            controller.abort();
            const { chain, calls } = fakeChain({ owner: ALICE, accountParticipant: raw() });
            const result = await readPersonhoodState(chain, {
                username: "alice.dot",
                signal: controller.signal,
            });
            expect(result.ok).toBe(false);
            expect(calls).toHaveLength(0);
        });

        test("a malformed grace ratio arrives on the err channel", async () => {
            const { chain } = fakeChain({ owner: ALICE, grace: "0xZZ" });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(result.ok).toBe(false);
            expect(isErrorOf(unwrapErr(result), IndividualityDecodeError)).toBe(true);
        });

        test("a transport failure arrives on the err channel, typed", async () => {
            const { chain } = fakeChain({ owner: ALICE });
            chain.raw.individuality.getFinalizedBlock = async () => {
                throw new Error("websocket closed");
            };
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(result.ok).toBe(false);
            const error = unwrapErr(result);
            expect(error.source).toBe("individuality");
            expect((error.cause as Error).message).toBe("websocket closed");
        });

        test("a rejection inside the parallel batch arrives on the err channel, typed", async () => {
            // The test above fails before the batch is reached; this one fails
            // inside it. The alias makes the fallback reachable, so asserting it
            // never ran proves no partial state is published.
            const { chain, calls } = fakeChain({
                owner: ALICE,
                alias: { ca: { alias: ALIAS } },
                personParticipant: raw(),
            });
            chain.individuality.query.Score.AbsenceGraceRatio.getValue = async () => {
                throw new Error("storage read failed");
            };
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(result.ok).toBe(false);
            const error = unwrapErr(result);
            expect(error.source).toBe("individuality");
            expect((error.cause as Error).message).toBe("storage read failed");
            expect(calls.some((c) => c.entry === "Participants:Person")).toBe(false);
        });

        // --- the account input (#287 item 6) ---------------------------------

        test("an account input skips the username lookup entirely", async () => {
            const { chain, calls } = fakeChain({ owner: ALICE, accountParticipant: raw() });
            const result = await readPersonhoodState(chain, { account: ALICE });
            expect(calls.some((c) => c.entry === "UsernameOwnerOf")).toBe(false);
            // Skipping the lookup must not skip the batch: the account-keyed
            // reads still have to run, keyed by the account given.
            expect(unwrapOk(result)).toMatchObject({ tag: "Resolved", accountAddress: ALICE });
            expect(keyOfIn(calls, "Participants:Account")).toEqual(Enum("Account", ALICE));
        });

        test("an account with no records resolves to NotEnrolled, never UsernameUnowned", async () => {
            // `UsernameUnowned` is unreachable on this path: nothing was looked
            // up, so there is no owner to be missing.
            const { chain } = fakeChain({});
            const result = await readPersonhoodState(chain, { account: ALICE });
            expect(unwrapOk(result)).toMatchObject({
                tag: "Resolved",
                accountAddress: ALICE,
                state: { tag: "NotEnrolled" },
            });
        });

        test("neither input arrives on the err channel, and costs no round trip", async () => {
            const { chain, calls, blockFetches } = fakeChain({ owner: ALICE });
            const result = await readPersonhoodState(chain, {} as ReadPersonhoodStateOptions);
            expect(isErrorOf(unwrapErr(result), ProductIndividualityError)).toBe(true);
            expect(blockFetches()).toBe(0);
            expect(calls).toEqual([]);
        });

        test("both inputs at once is an error, never a silent choice", async () => {
            // Without the runtime check the account wins in silence.
            const { chain, calls, blockFetches } = fakeChain({
                owner: BOB,
                accountParticipant: raw(),
            });
            const result = await readPersonhoodState(chain, {
                username: "bob.dot",
                account: ALICE,
            } as unknown as ReadPersonhoodStateOptions);
            expect(isErrorOf(unwrapErr(result), ProductIndividualityError)).toBe(true);
            expect(blockFetches()).toBe(0);
            expect(calls).toEqual([]);
        });

        test("a null or empty input is no input at all", async () => {
            // Each would otherwise be taken as the input.
            const degenerate = [{ account: null }, { account: "" }, { username: "" }];
            for (const options of degenerate) {
                const { chain, blockFetches } = fakeChain({ owner: ALICE });
                const result = await readPersonhoodState(
                    chain,
                    options as unknown as ReadPersonhoodStateOptions,
                );
                expect(isErrorOf(unwrapErr(result), ProductIndividualityError)).toBe(true);
                expect(blockFetches()).toBe(0);
            }
        });

        // --- the metrics alongside the state (#287 item 7) --------------------

        test("carries the metrics for a Member, whose variant has no score", async () => {
            // The gap item 7 names: a progress bar cannot read a score off
            // `Member`, because the variant does not carry one.
            const { chain } = fakeChain({ owner: ALICE, threshold: 5, accountParticipant: raw() });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                state: { tag: "Member" },
                metrics: {
                    score: 7,
                    personhoodThreshold: 5,
                    misses: 0,
                    allowedMisses: 1,
                    window: 8,
                },
            });
        });

        test("nulls the record-derived metrics for NotEnrolled, keeps the policy", async () => {
            const { chain } = fakeChain({ owner: ALICE, threshold: 11 });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                state: { tag: "NotEnrolled" },
                // No record means no score and no history to count. The
                // threshold and the policy are unkeyed values, so they stand.
                metrics: {
                    score: null,
                    personhoodThreshold: 11,
                    misses: null,
                    allowedMisses: 1,
                    window: 8,
                },
            });
        });

        test("metrics.misses counts the window now; Caution.misses projects one more absence", async () => {
            // 0b11001111: two absences inside the window today. Shifting one
            // more in leaves three, which is what the policy is evaluated
            // against — so the two fields must not agree, and a UI reading
            // "missed 2 of 8" wants the metric, not the projection.
            const { chain } = fakeChain({
                owner: ALICE,
                accountParticipant: raw({ attendance_history: 0b11001111 }),
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({
                state: { tag: "Caution", misses: 3, allowedMisses: 1, window: 8 },
                metrics: { misses: 2, allowedMisses: 1, window: 8 },
            });
        });

        // --- inherited from humanity-spa's toHumanityCardResult suite ----------

        test("keys the result by the username-owner account and contextual alias", async () => {
            const { chain } = fakeChain({
                owner: ALICE,
                accountParticipant: raw(),
                alias: { ca: { alias: ALIAS } },
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({ accountAddress: ALICE, alias: ALIAS });
        });

        test("keeps a missing contextual alias null, never the DotNS text", async () => {
            const { chain } = fakeChain({ owner: ALICE, accountParticipant: raw() });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(unwrapOk(result)).toMatchObject({ alias: null });
            expect(JSON.stringify(result)).not.toContain("alice.dot");
        });

        test("derives Lite and NotEnrolled when no participant record exists", async () => {
            const lite = await readPersonhoodState(
                fakeChain({ owner: ALICE, lite: { ring_vrf_key: "0x00" } }).chain,
                { username: "alice.dot" },
            );
            expect(unwrapOk(lite)).toMatchObject({ state: { tag: "Lite" } });

            const notEnrolled = await readPersonhoodState(
                fakeChain({ owner: ALICE, lite: undefined }).chain,
                { username: "alice.dot" },
            );
            expect(unwrapOk(notEnrolled)).toMatchObject({ state: { tag: "NotEnrolled" } });
        });

        test("wires the personhood threshold and grace policy into the state", async () => {
            const candidate = await readPersonhoodState(
                fakeChain({
                    owner: ALICE,
                    threshold: 11,
                    accountParticipant: raw({
                        score: 4,
                        recognition: { type: "NotRecognized" },
                        reached_personhood: false,
                    }),
                }).chain,
                { username: "alice.dot" },
            );
            expect(unwrapOk(candidate)).toMatchObject({
                state: { tag: "Candidate", score: 4, personhoodThreshold: 11 },
            });

            // 0x0008 -> allowedMisses 0, window 8: a clean history still cautions.
            const cautioned = await readPersonhoodState(
                fakeChain({ owner: ALICE, grace: "0x0008", accountParticipant: raw() }).chain,
                { username: "alice.dot" },
            );
            expect(unwrapOk(cautioned)).toMatchObject({
                state: { tag: "Caution", allowedMisses: 0, window: 8 },
            });
        });
    });
}
