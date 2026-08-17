// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The pinned read: one username in, one {@link PersonhoodResult} out.
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
 * ```
 */
import { Enum } from "polkadot-api";
import { derivePersonhoodState, type PersonhoodParticipant } from "./derive.js";
import {
    decodeAbsenceGracePolicy,
    toPersonhoodParticipant,
    type RawParticipant,
} from "./decode.js";
import type { FinalizedSnapshot, PersonhoodResult } from "./types.js";

/** Options every storage read is given, so all six agree on one block. */
interface ReadAt {
    at: string;
    signal?: AbortSignal;
}

/** `People.AccountToAlias`, narrowed to the contextual alias the read keys on. */
interface RawAccountAlias {
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
 * **Fidelity is maintained by hand, and a compile-time assertion cannot help.**
 * Inside any `packages/*` tsconfig (`moduleResolution: "NodeNext"`) the
 * descriptors resolve to `any` — their generated `index.d.ts` is ESM with
 * extensionless relative imports, which NodeNext rejects — so
 * `ChainClient<{ individuality: typeof paseo_individuality }>` is `TypedApi<any>`
 * and satisfies *any* contract vacuously. Each entry below was instead matched by
 * hand on 2026-08-17 against
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
 * Re-check them by hand after any descriptor regeneration.
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
            };
        };
    };
    raw: {
        individuality: {
            getFinalizedBlock(): Promise<{ hash: string; number: number }>;
        };
    };
}

/** Options for {@link readPersonhoodState}. */
export interface ReadPersonhoodStateOptions {
    /**
     * The DotNS username, UTF-8 encoded as-is with no normalization. Pass the
     * exact byte string the chain stores, `.dot` suffix included.
     */
    username: string;
    /**
     * Forwarded into every underlying pull, so an aborted caller stops the
     * whole batch. No deadline is applied here — that belongs to the caller, or
     * eventually to `chain-client`.
     */
    signal?: AbortSignal;
}

/**
 * Read a DotNS username's personhood state from one pinned finalized block.
 *
 * A username nobody owns resolves to `UsernameUnowned` on the success channel;
 * it is a valid answer, not an error. Throws only
 * `IndividualityDecodeError`, when the chain returns a shape the descriptor says
 * is impossible.
 *
 * **Not an authorization oracle.** This is a client-side read in a client-side
 * library, and a backend that trusts "the SDK said `Member`" is trivially
 * spoofed.
 */
export async function readPersonhoodState(
    chain: IndividualityChain,
    options: ReadPersonhoodStateOptions,
): Promise<PersonhoodResult> {
    const { username, signal } = options;
    const query = chain.individuality.query;

    // Pin one finalized block: every read below must agree on it.
    const block = await chain.raw.individuality.getFinalizedBlock();
    const at: ReadAt = { at: block.hash, signal };
    const snapshot: FinalizedSnapshot = { blockHash: block.hash, blockNumber: block.number };

    // The entry point is `Resources.UsernameOwnerOf` on the individuality
    // chain's resources pallet — not `pallet_identity` on the fellows People
    // chain. Those are unrelated username systems.
    const owner = await query.Resources.UsernameOwnerOf.getValue(
        new TextEncoder().encode(username),
        at,
    );
    if (owner == null) {
        return { tag: "UsernameUnowned", at: snapshot };
    }

    const [accountParticipant, alias, litePerson, personhoodThreshold, absenceGraceRatio] =
        await Promise.all([
            query.Score.Participants.getValue(Enum("Account", owner), at),
            query.People.AccountToAlias.getValue(owner, at),
            query.PeopleLite.LitePeople.getValue(owner, at),
            // `PersonhoodThreshold` is a u8. PAPI types both u8 and u32 as
            // number, so a width mistake typechecks and passes tests.
            query.Score.PersonhoodThreshold.getValue(at),
            query.Score.AbsenceGraceRatio.getValue(at),
        ]);

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
            policy: decodeAbsenceGracePolicy(absenceGraceRatio),
        }),
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const ALIAS = `0x${"ab".repeat(32)}`;
    const BLOCK = { hash: `0x${"11".repeat(32)}`, number: 5_000 };

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
        lite?: unknown;
        threshold?: number;
        grace?: string;
    }

    /** A chain double that records the options every read was given. */
    function fakeChain(state: FakeState) {
        const calls: Array<{ entry: string; at: string; signal?: AbortSignal }> = [];
        const record = (entry: string, options: ReadAt) => {
            calls.push({ entry, at: options.at, signal: options.signal });
        };
        const chain: IndividualityChain = {
            individuality: {
                query: {
                    Resources: {
                        UsernameOwnerOf: {
                            async getValue(_key, options) {
                                record("UsernameOwnerOf", options);
                                return state.owner;
                            },
                        },
                    },
                    Score: {
                        Participants: {
                            async getValue(key, options) {
                                record(`Participants:${key.type}`, options);
                                return key.type === "Account"
                                    ? state.accountParticipant
                                    : state.personParticipant;
                            },
                        },
                        PersonhoodThreshold: {
                            async getValue(options) {
                                record("PersonhoodThreshold", options);
                                return state.threshold ?? 5;
                            },
                        },
                        AbsenceGraceRatio: {
                            async getValue(options) {
                                record("AbsenceGraceRatio", options);
                                return state.grace ?? "0x0108";
                            },
                        },
                    },
                    People: {
                        AccountToAlias: {
                            async getValue(_key, options) {
                                record("AccountToAlias", options);
                                return state.alias;
                            },
                        },
                    },
                    PeopleLite: {
                        LitePeople: {
                            async getValue(_key, options) {
                                record("LitePeople", options);
                                return state.lite;
                            },
                        },
                    },
                },
            },
            raw: {
                individuality: {
                    async getFinalizedBlock() {
                        return BLOCK;
                    },
                },
            },
        };
        return { chain, calls };
    }

    describe("readPersonhoodState", () => {
        test("an unowned username is a success value, and stops after one read", async () => {
            const { chain, calls } = fakeChain({ owner: undefined });
            const result = await readPersonhoodState(chain, { username: "nobody.dot" });
            expect(result).toEqual({
                tag: "UsernameUnowned",
                at: { blockHash: BLOCK.hash, blockNumber: BLOCK.number },
            });
            // The five-read batch must not run once the username is unowned.
            expect(calls.map((c) => c.entry)).toEqual(["UsernameOwnerOf"]);
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
            expect(result).toMatchObject({
                tag: "Resolved",
                accountAddress: ALICE,
                state: { tag: "Member", activeWeeks: 4, lastAttendedGame: 42 },
            });
            // Exactly one Participants read: the account key hit.
            expect(calls.filter((c) => c.entry.startsWith("Participants:"))).toHaveLength(1);
            expect(calls.some((c) => c.entry === "Participants:Person")).toBe(false);
        });

        test("the account-keyed record wins when both keys hold one", async () => {
            // Caught by mutation testing: reversing the `??` chain changes which
            // record wins, and nothing else here notices. Score 7 is the account
            // record; 99 is the alias one.
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
            expect(result).toMatchObject({ state: { tag: "Candidate", score: 7 } });
        });

        test("falls back to the alias key when no account-keyed record exists", async () => {
            const { chain, calls } = fakeChain({
                owner: ALICE,
                accountParticipant: undefined,
                alias: { ca: { alias: ALIAS } },
                personParticipant: raw({ score: 3, recognition: { type: "NotRecognized" } }),
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(result).toMatchObject({
                tag: "Resolved",
                alias: ALIAS,
                state: { tag: "MembershipReady" },
            });
            // Account key first, then the Person key — order matters.
            expect(
                calls.filter((c) => c.entry.startsWith("Participants:")).map((c) => c.entry),
            ).toEqual(["Participants:Account", "Participants:Person"]);
        });

        test("skips the fallback entirely when there is no alias", async () => {
            const { chain, calls } = fakeChain({ owner: ALICE, alias: undefined, lite: undefined });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(result).toMatchObject({
                tag: "Resolved",
                alias: null,
                state: { tag: "NotEnrolled" },
            });
            expect(calls.some((c) => c.entry === "Participants:Person")).toBe(false);
        });

        test("all reads share one pinned finalized block", async () => {
            // The whole point of the function. Two of the six values move on a
            // session cadence, so a second block here would mix eras silently.
            const { chain, calls } = fakeChain({
                owner: ALICE,
                alias: { ca: { alias: ALIAS } },
                personParticipant: raw(),
            });
            await readPersonhoodState(chain, { username: "alice.dot" });
            expect(calls).toHaveLength(7); // 1 owner + 5 batch + 1 alias fallback
            expect(new Set(calls.map((c) => c.at))).toEqual(new Set([BLOCK.hash]));
        });

        test("forwards the abort signal into every read", async () => {
            const controller = new AbortController();
            const { chain, calls } = fakeChain({ owner: ALICE, accountParticipant: raw() });
            await readPersonhoodState(chain, {
                username: "alice.dot",
                signal: controller.signal,
            });
            expect(calls).toHaveLength(6);
            expect(calls.every((c) => c.signal === controller.signal)).toBe(true);
        });

        // --- inherited from humanity-spa's toHumanityCardResult suite ----------

        test("keys the result by the username-owner account and contextual alias", async () => {
            const { chain } = fakeChain({
                owner: ALICE,
                accountParticipant: raw(),
                alias: { ca: { alias: ALIAS } },
            });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(result).toMatchObject({ accountAddress: ALICE, alias: ALIAS });
        });

        test("keeps a missing contextual alias null, never the DotNS text", async () => {
            const { chain } = fakeChain({ owner: ALICE, accountParticipant: raw() });
            const result = await readPersonhoodState(chain, { username: "alice.dot" });
            expect(result).toMatchObject({ alias: null });
            expect(JSON.stringify(result)).not.toContain("alice.dot");
        });

        test("derives Lite and NotEnrolled when no participant record exists", async () => {
            const lite = await readPersonhoodState(
                fakeChain({ owner: ALICE, lite: { ring_vrf_key: "0x00" } }).chain,
                { username: "alice.dot" },
            );
            expect(lite).toMatchObject({ state: { tag: "Lite" } });

            const notEnrolled = await readPersonhoodState(
                fakeChain({ owner: ALICE, lite: undefined }).chain,
                { username: "alice.dot" },
            );
            expect(notEnrolled).toMatchObject({ state: { tag: "NotEnrolled" } });
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
            expect(candidate).toMatchObject({
                state: { tag: "Candidate", score: 4, personhoodThreshold: 11 },
            });

            // 0x0008 -> allowedMisses 0, window 8: a clean history still cautions.
            const cautioned = await readPersonhoodState(
                fakeChain({ owner: ALICE, grace: "0x0008", accountParticipant: raw() }).chain,
                { username: "alice.dot" },
            );
            expect(cautioned).toMatchObject({
                state: { tag: "Caution", allowedMisses: 0, window: 8 },
            });
        });
    });
}
