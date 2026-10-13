// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `PeopleAirdrops` — the recurring prize draws a person enters under their
 * airdrop alias, not under an account.
 *
 * A person takes part through one contextual alias: `People.AccountToAlias`
 * maps the product account that signs to `{ ring, revision, ca: { alias,
 * context } }`, and only a binding whose `context` is the pallet's
 * `people_airdrops_context` counts. Registering for a draw is
 * `PeopleAirdrops.register { event_ids }`, dispatched under that alias
 * (`withAsPerson`), and the chain files the entry under a per-draw *slot*:
 * `blake2_256("pop:people-airdrops:slot" ‖ event_id ‖ salt ‖ alias)`, with the
 * salt from `PeopleAirdrops.DrawSalts`. The slot is what makes "am I in this
 * draw" a point read instead of a scan.
 *
 * Three pieces, each usable alone:
 *
 * - {@link readPeopleAirdropsStanding} — every `PeopleAirdrops` draw on chain,
 *   and for each whether this account's alias is registered and has won, all
 *   at one pinned block.
 * - {@link readPeopleAirdropsSigning} — which `withAsPerson` origin a
 *   registration can ride right now. `AliasWithAccount` needs nothing but the
 *   account's signature; a ring that moved on since the binding needs a fresh
 *   proof (`AliasWithAccountRevised`); no binding at all needs
 *   `People.set_alias_account`, which is a proof made with the personhood
 *   product's key and therefore the caller's business, not this package's.
 * - {@link peopleAirdropsRegisterCalls} — the register calls, already chunked
 *   to the chain's `MaxRegisterBatch`.
 *
 * ```ts
 * import { submitAndWatch } from "@parity/product-sdk-tx";
 * import {
 *     fromPapi,
 *     peopleAirdropsRegisterCalls,
 *     readPeopleAirdropsSigning,
 *     readPeopleAirdropsStanding,
 *     withAsPerson,
 * } from "@parity/product-sdk-individuality";
 *
 * const chain = fromPapi(client.getTypedApi(individuality), client);
 * const standing = await readPeopleAirdropsStanding(chain, { account });
 * const open = standing.ok
 *     ? standing.value.draws.filter((d) => d.event.phase === "Registering" && d.registered === false)
 *     : [];
 * const signing = await readPeopleAirdropsSigning(chain, { account });
 * if (open.length > 0 && signing.ok && signing.value.tag === "Bound") {
 *     const calls = await peopleAirdropsRegisterCalls(chain, open.map((d) => d.event.eventId));
 *     if (calls.ok) {
 *         for (const { tx } of calls.value) {
 *             await submitAndWatch(tx, withAsPerson(signer, { tag: "AliasWithAccount" }));
 *         }
 *     }
 * }
 * ```
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { blake2b256, bytesToHex, hexToBytes } from "@parity/product-sdk-utils";
import {
    toAirdropEvent,
    type RawActiveEvent,
    type RawRegistrationEntry,
} from "./airdrop-decode.js";
import {
    GAME_AIRDROP_EVENT_ID_BASE,
    gameAirdropEventId,
    parsePeopleAirdropsEventId,
    peopleAirdropsEventId,
} from "./airdrop-ids.js";
import type { AirdropEvent } from "./airdrop-types.js";
import { IndividualityDecodeError, ProductIndividualityError } from "./errors.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import { ringCollectionId } from "./rings.js";
import type { BlockAt, BlockSnapshot } from "./types.js";

/** `People.AccountToAlias`, as stored. */
export interface RawPeopleAccountAlias {
    revision: number;
    ring: number;
    ca: { alias: string; context: string };
}

/**
 * The chain surface the reads need — structural, so a typed PAPI api from
 * `fromPapi`, any network's descriptors, or a test double all satisfy it.
 */
export interface PeopleAirdropsChain extends PinnedChain {
    individuality: {
        constants: {
            PeopleAirdrops: {
                people_airdrops_context(): Promise<string>;
            };
        };
        query: {
            People: {
                AccountToAlias: {
                    getValue(
                        account: string,
                        options: ReadAt,
                    ): Promise<RawPeopleAccountAlias | undefined>;
                };
            };
            Members: {
                Root: {
                    getValue(
                        collection: string,
                        ring: number,
                        options: ReadAt,
                    ): Promise<{ revision: number } | undefined>;
                };
            };
            PeopleAirdrops: {
                DrawSalts: {
                    getValues(
                        keys: Array<[string]>,
                        options: ReadAt,
                    ): Promise<Array<[string, bigint] | undefined>>;
                };
            };
            Airdrop: {
                Events: {
                    getEntries(
                        options: ReadAt,
                    ): Promise<Array<{ keyArgs: [string]; value: RawActiveEvent }>>;
                };
                Registrations: {
                    getValues(
                        keys: Array<[string, string]>,
                        options: ReadAt,
                    ): Promise<Array<unknown>>;
                };
                Winners: {
                    getValues(
                        keys: Array<[string, RawRegistrationEntry]>,
                        options: ReadAt,
                    ): Promise<Array<string | undefined>>;
                };
            };
        };
    };
}

/** What `People.AccountToAlias` says about one account, against the airdrops context. */
export type PeopleAirdropsBinding =
    /** No alias is bound to the account. */
    | { tag: "Unbound" }
    /** An alias is bound, under some other context: it cannot enter `PeopleAirdrops` draws. */
    | { tag: "OtherContext"; context: string }
    /** The account's alias is the airdrops one. */
    | { tag: "Bound"; alias: string; ring: number; revision: number };

export interface PeopleAirdropsAlias {
    /** `PeopleAirdrops.people_airdrops_context`, the context an entering alias must carry. */
    airdropsContext: string;
    binding: PeopleAirdropsBinding;
}

/** One `PeopleAirdrops` draw, and where this account's alias stands in it. */
export interface PeopleAirdropEntry {
    drawIndex: bigint;
    event: AirdropEvent;
    /** The alias's slot in the draw; `null` without an alias or before the draw has a salt. */
    slot: string | null;
    /** Whether `Airdrop.Registrations` holds the slot; `null` when there is no slot to look up. */
    registered: boolean | null;
    /** Whether `Airdrop.Winners` holds the alias; `null` without an alias. */
    won: boolean | null;
}

export interface PeopleAirdropsStanding {
    at: BlockSnapshot;
    account: string;
    alias: PeopleAirdropsAlias;
    /** Every `PeopleAirdrops` draw still on chain, oldest draw index first. */
    draws: PeopleAirdropEntry[];
}

export interface ReadPeopleAirdropsOptions {
    /** The account `People.AccountToAlias` is keyed by — the one that signs registrations. */
    account: string;
    /** Defaults to `"best"`: a registration cares about the draws accepting entries now. */
    at?: BlockAt;
    signal?: AbortSignal;
}

const SLOT_DOMAIN = new TextEncoder().encode("pop:people-airdrops:slot");
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function hex32Bytes(value: string, what: string): Uint8Array {
    if (!HEX32.test(value)) {
        throw new ProductIndividualityError(`${what} must be 32 bytes of 0x-prefixed hex`);
    }
    return hexToBytes(value.slice(2));
}

/**
 * The slot an alias's entry in one draw is filed under:
 * `blake2_256("pop:people-airdrops:slot" ‖ event_id ‖ salt ‖ alias)`, a raw
 * concatenation of the 24-byte domain and three 32-byte values.
 */
export function derivePeopleAirdropsSlot(eventId: string, salt: string, alias: string): string {
    const preimage = new Uint8Array(SLOT_DOMAIN.length + 96);
    preimage.set(SLOT_DOMAIN, 0);
    preimage.set(hex32Bytes(eventId, "eventId"), SLOT_DOMAIN.length);
    preimage.set(hex32Bytes(salt, "salt"), SLOT_DOMAIN.length + 32);
    preimage.set(hex32Bytes(alias, "alias"), SLOT_DOMAIN.length + 64);
    return `0x${bytesToHex(blake2b256(preimage))}`;
}

async function runAliasRead(
    chain: PeopleAirdropsChain,
    account: string,
    at: ReadAt,
): Promise<{ alias: PeopleAirdropsAlias; raw: RawPeopleAccountAlias | undefined }> {
    const [airdropsContext, raw] = await Promise.all([
        chain.individuality.constants.PeopleAirdrops.people_airdrops_context(),
        chain.individuality.query.People.AccountToAlias.getValue(account, at),
    ]);
    let binding: PeopleAirdropsBinding;
    if (raw === undefined) {
        binding = { tag: "Unbound" };
    } else if (raw.ca.context.toLowerCase() !== airdropsContext.toLowerCase()) {
        binding = { tag: "OtherContext", context: raw.ca.context };
    } else {
        binding = { tag: "Bound", alias: raw.ca.alias, ring: raw.ring, revision: raw.revision };
    }
    return { alias: { airdropsContext, binding }, raw };
}

/**
 * Every `PeopleAirdrops` draw on chain and where `account` stands in each, read
 * at one block. `Airdrop.Events` also holds other schedulers' draws (the weekly
 * game's); those are skipped by event id.
 */
export async function readPeopleAirdropsStanding(
    chain: PeopleAirdropsChain,
    options: ReadPeopleAirdropsOptions,
): Promise<Result<PeopleAirdropsStanding, ProductIndividualityError>> {
    try {
        const { account, signal } = options;
        const snapshot = await pinBlock(chain, signal, options.at ?? "best");
        const at = readAt(snapshot, signal);
        const query = chain.individuality.query;

        const [{ alias }, entries] = await Promise.all([
            runAliasRead(chain, account, at),
            query.Airdrop.Events.getEntries(at),
        ]);

        const draws: Array<{ drawIndex: bigint; event: AirdropEvent }> = [];
        for (const { keyArgs, value } of entries) {
            const drawIndex = parsePeopleAirdropsEventId(keyArgs[0]);
            if (drawIndex === null) continue;
            draws.push({ drawIndex, event: toAirdropEvent(keyArgs[0], value) });
        }
        draws.sort((a, b) => (a.drawIndex < b.drawIndex ? -1 : a.drawIndex > b.drawIndex ? 1 : 0));

        const bound = alias.binding.tag === "Bound" ? alias.binding.alias : null;
        if (bound === null || draws.length === 0) {
            return ok({
                at: snapshot,
                account,
                alias,
                draws: draws.map((d) => ({ ...d, slot: null, registered: null, won: null })),
            });
        }

        const eventIds = draws.map((d) => d.event.eventId);
        const [salts, winners] = await Promise.all([
            query.PeopleAirdrops.DrawSalts.getValues(
                eventIds.map((id) => [id] as [string]),
                at,
            ),
            query.Airdrop.Winners.getValues(
                eventIds.map(
                    (id) =>
                        [id, { type: "Alias", value: { alias: bound } }] as [
                            string,
                            RawRegistrationEntry,
                        ],
                ),
                at,
            ),
        ]);
        const slots = eventIds.map((id, i) => {
            const salt = salts[i];
            return salt === undefined ? null : derivePeopleAirdropsSlot(id, salt[0], bound);
        });
        const keys: Array<[string, string]> = [];
        for (const [i, slot] of slots.entries()) {
            if (slot !== null) keys.push([eventIds[i] as string, slot]);
        }
        const registrations =
            keys.length === 0 ? [] : await query.Airdrop.Registrations.getValues(keys, at);
        const registered = new Map(keys.map(([id], i) => [id, registrations[i] !== undefined]));

        return ok({
            at: snapshot,
            account,
            alias,
            draws: draws.map((d, i) => ({
                ...d,
                slot: slots[i] ?? null,
                registered: registered.get(d.event.eventId) ?? null,
                won: winners[i] !== undefined,
            })),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** Which `withAsPerson` origin a `PeopleAirdrops` call can ride for this account now. */
export type PeopleAirdropsSigning =
    /** `withAsPerson(signer, { tag: "AliasWithAccount" })` — the account's signature is enough. */
    | { tag: "Bound"; alias: string }
    /**
     * The binding's ring has moved on: `AliasWithAccountRevised`, whose proof is
     * made by the personhood key for `aliasContext`.
     */
    | { tag: "Revised"; alias: string; aliasContext: string; ring: number }
    /** No airdrops alias yet: bind one with `People.set_alias_account` first. */
    | { tag: "Unbound"; airdropsContext: string }
    /** The account is bound under another context; this account cannot enter the draws. */
    | { tag: "OtherContext"; context: string }
    /** The binding's ring has no root on chain, so no origin can be built. */
    | { tag: "RingUnavailable"; ring: number };

/**
 * Reads `People.AccountToAlias` and the `people` ring's current root, and says
 * which origin a registration needs. Pure reads: this never signs or proves.
 */
export async function readPeopleAirdropsSigning(
    chain: PeopleAirdropsChain,
    options: ReadPeopleAirdropsOptions,
): Promise<Result<PeopleAirdropsSigning, ProductIndividualityError>> {
    try {
        const snapshot = await pinBlock(chain, options.signal, options.at ?? "best");
        const at = readAt(snapshot, options.signal);
        const { alias, raw } = await runAliasRead(chain, options.account, at);
        const { binding } = alias;
        if (binding.tag === "Unbound")
            return ok({ tag: "Unbound", airdropsContext: alias.airdropsContext });
        if (binding.tag === "OtherContext") return ok(binding);

        const root = await chain.individuality.query.Members.Root.getValue(
            `0x${bytesToHex(ringCollectionId("people"))}`,
            binding.ring,
            at,
        );
        if (root === undefined) return ok({ tag: "RingUnavailable", ring: binding.ring });
        if (root.revision === binding.revision) return ok({ tag: "Bound", alias: binding.alias });
        return ok({
            tag: "Revised",
            alias: binding.alias,
            aliasContext: (raw as RawPeopleAccountAlias).ca.context,
            ring: binding.ring,
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** The chain surface {@link peopleAirdropsRegisterCalls} needs. */
export interface PeopleAirdropsRegisterChain<Tx> {
    individuality: {
        constants: {
            PeopleAirdrops: {
                MaxRegisterBatch(): Promise<number>;
            };
        };
        tx: {
            PeopleAirdrops: {
                register(args: { event_ids: string[] }): Tx;
            };
        };
    };
}

/** Used only when the runtime does not expose `MaxRegisterBatch`. */
export const FALLBACK_PEOPLE_AIRDROPS_REGISTER_BATCH = 16;

export interface PeopleAirdropsRegisterCall<Tx> {
    eventIds: string[];
    tx: Tx;
}

/**
 * `PeopleAirdrops.register` calls for `eventIds`, split so no call exceeds the
 * runtime's `MaxRegisterBatch`. Sign each under the origin
 * {@link readPeopleAirdropsSigning} reports. Duplicate ids are dropped; an empty
 * list yields no calls, since the pallet refuses an empty registration.
 */
export async function peopleAirdropsRegisterCalls<Tx>(
    chain: PeopleAirdropsRegisterChain<Tx>,
    eventIds: readonly string[],
): Promise<Result<PeopleAirdropsRegisterCall<Tx>[], ProductIndividualityError>> {
    try {
        const unique = [...new Set(eventIds)];
        for (const id of unique) {
            if (parsePeopleAirdropsEventId(id) === null) {
                throw new IndividualityDecodeError(`${id} is not a PeopleAirdrops event id`);
            }
        }
        if (unique.length === 0) return ok([]);
        let batch = FALLBACK_PEOPLE_AIRDROPS_REGISTER_BATCH;
        try {
            const onChain = await chain.individuality.constants.PeopleAirdrops.MaxRegisterBatch();
            if (Number.isInteger(onChain) && onChain > 0) batch = onChain;
        } catch {
            // Older runtimes do not expose the constant; the fallback is the pallet's default.
        }
        const calls: PeopleAirdropsRegisterCall<Tx>[] = [];
        for (let i = 0; i < unique.length; i += batch) {
            const chunk = unique.slice(i, i + batch);
            calls.push({
                eventIds: chunk,
                tx: chain.individuality.tx.PeopleAirdrops.register({ event_ids: chunk }),
            });
        }
        return ok(calls);
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const CONTEXT = `0x${"c0".repeat(32)}`;
    const ALIAS = `0x${"a1".repeat(32)}`;
    const SALT = `0x${"5a".repeat(32)}`;
    const BEST = { hash: `0x${"77".repeat(32)}`, number: 79 };
    const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const DRAW_0 = peopleAirdropsEventId(0n);
    const DRAW_1 = peopleAirdropsEventId(1n);
    const GAME = gameAirdropEventId({
        base: GAME_AIRDROP_EVENT_ID_BASE,
        gameIndex: 3,
        airdropIndex: 0,
    });

    const rawEvent = (id: string, status = "Registering"): RawActiveEvent => ({
        id,
        info: {
            prize: {
                asset_id: { parents: 1, interior: { type: "Here", value: undefined } },
                asset_amount: 1_000_000n,
                max_winners: 10,
                winner_cap: 1000,
            },
            registration_starts: 1_770_000_000n,
            draw_time: 1_770_003_600n,
            end_time: 1_770_090_000n,
        },
        status: {
            type: status,
            value: { total_participants: 4, effective_winners: 1, claimed: 0 },
        },
    });

    interface Fake {
        alias?: RawPeopleAccountAlias;
        rootRevision?: number;
        salts?: Record<string, string>;
        registeredSlots?: Set<string>;
        winners?: Set<string>;
    }

    function fakeChain(fake: Fake): PeopleAirdropsChain & { reads: string[] } {
        const reads: string[] = [];
        return {
            reads,
            raw: {
                individuality: {
                    getFinalizedBlock: async () => BEST,
                    getBestBlocks: async () => [BEST],
                },
            },
            individuality: {
                constants: { PeopleAirdrops: { people_airdrops_context: async () => CONTEXT } },
                query: {
                    People: { AccountToAlias: { getValue: async () => fake.alias } },
                    Members: {
                        Root: {
                            getValue: async () =>
                                fake.rootRevision === undefined
                                    ? undefined
                                    : { revision: fake.rootRevision },
                        },
                    },
                    PeopleAirdrops: {
                        DrawSalts: {
                            getValues: async (keys) => {
                                reads.push("salts");
                                return keys.map(([id]) => {
                                    const salt = fake.salts?.[id];
                                    return salt === undefined ? undefined : [salt, 0n];
                                });
                            },
                        },
                    },
                    Airdrop: {
                        Events: {
                            getEntries: async () => [
                                { keyArgs: [DRAW_1], value: rawEvent(DRAW_1) },
                                { keyArgs: [GAME], value: rawEvent(GAME) },
                                { keyArgs: [DRAW_0], value: rawEvent(DRAW_0, "Claiming") },
                            ],
                        },
                        Registrations: {
                            getValues: async (keys) => {
                                reads.push(`registrations:${keys.length}`);
                                return keys.map(([, slot]) =>
                                    fake.registeredSlots?.has(slot) ? {} : undefined,
                                );
                            },
                        },
                        Winners: {
                            getValues: async (keys) =>
                                keys.map(([id]) => (fake.winners?.has(id) ? "0x01" : undefined)),
                        },
                    },
                },
            },
        };
    }

    const bound: RawPeopleAccountAlias = {
        revision: 7,
        ring: 2,
        ca: { alias: ALIAS, context: CONTEXT },
    };

    describe("derivePeopleAirdropsSlot", () => {
        test("hashes the 120-byte domain-separated preimage", () => {
            const preimage = new Uint8Array(120);
            preimage.set(new TextEncoder().encode("pop:people-airdrops:slot"), 0);
            preimage.set(hexToBytes(DRAW_0.slice(2)), 24);
            preimage.set(hexToBytes(SALT.slice(2)), 56);
            preimage.set(hexToBytes(ALIAS.slice(2)), 88);
            expect(derivePeopleAirdropsSlot(DRAW_0, SALT, ALIAS)).toBe(
                `0x${bytesToHex(blake2b256(preimage))}`,
            );
        });

        test("matches the slot Humanity's deriveDrawSlot computes for the same inputs", () => {
            // Computed with Humanity's `deriveDrawSlot` (`@noble/hashes` blake2b, dkLen 32).
            expect(
                derivePeopleAirdropsSlot(
                    `0x${"01".repeat(32)}`,
                    `0x${"02".repeat(32)}`,
                    `0x${"03".repeat(32)}`,
                ),
            ).toBe("0x958a4a6a503792d7ec5b14e7af838695e849ac60c2010a9b9006033c75f08421");
        });

        test("refuses a value that is not 32 bytes", () => {
            expect(() => derivePeopleAirdropsSlot("0x01", SALT, ALIAS)).toThrow(
                ProductIndividualityError,
            );
        });
    });

    describe("readPeopleAirdropsStanding", () => {
        test("lists only PeopleAirdrops draws, in draw-index order", async () => {
            const result = await readPeopleAirdropsStanding(fakeChain({}), { account: ACCOUNT });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.draws.map((d) => d.drawIndex)).toEqual([0n, 1n]);
            expect(result.value.draws[0]?.event.phase).toBe("Claiming");
            expect(result.value.at).toEqual({ blockHash: BEST.hash, blockNumber: BEST.number });
        });

        test("without a binding, nothing is looked up and every answer is null", async () => {
            const chain = fakeChain({});
            const result = await readPeopleAirdropsStanding(chain, { account: ACCOUNT });
            if (!result.ok) throw result.error;
            expect(result.value.alias.binding).toEqual({ tag: "Unbound" });
            expect(
                result.value.draws.every(
                    (d) => d.slot === null && d.registered === null && d.won === null,
                ),
            ).toBe(true);
            expect(chain.reads).toEqual([]);
        });

        test("an alias bound under another context is not looked up", async () => {
            const chain = fakeChain({
                alias: { ...bound, ca: { alias: ALIAS, context: `0x${"ee".repeat(32)}` } },
            });
            const result = await readPeopleAirdropsStanding(chain, { account: ACCOUNT });
            if (!result.ok) throw result.error;
            expect(result.value.alias.binding.tag).toBe("OtherContext");
            expect(chain.reads).toEqual([]);
        });

        test("reads registration through the derived slot, and winners by alias", async () => {
            const slot = derivePeopleAirdropsSlot(DRAW_1, SALT, ALIAS);
            const chain = fakeChain({
                alias: bound,
                salts: { [DRAW_1]: SALT },
                registeredSlots: new Set([slot]),
                winners: new Set([DRAW_0]),
            });
            const result = await readPeopleAirdropsStanding(chain, { account: ACCOUNT });
            if (!result.ok) throw result.error;
            const [first, second] = result.value.draws;
            expect(first).toMatchObject({ drawIndex: 0n, slot: null, registered: null, won: true });
            expect(second).toMatchObject({ drawIndex: 1n, slot, registered: true, won: false });
            expect(chain.reads).toEqual(["salts", "registrations:1"]);
        });

        test("a chain failure is an error result, not a throw", async () => {
            const chain = fakeChain({});
            chain.individuality.query.Airdrop.Events.getEntries = async () => {
                throw new Error("rpc down");
            };
            const result = await readPeopleAirdropsStanding(chain, { account: ACCOUNT });
            expect(result.ok).toBe(false);
        });
    });

    describe("readPeopleAirdropsSigning", () => {
        test("unbound reports the context a binding must carry", async () => {
            const result = await readPeopleAirdropsSigning(fakeChain({}), { account: ACCOUNT });
            expect(result).toEqual({
                ok: true,
                value: { tag: "Unbound", airdropsContext: CONTEXT },
            });
        });

        test("a current ring signs with the account alone", async () => {
            const result = await readPeopleAirdropsSigning(
                fakeChain({ alias: bound, rootRevision: 7 }),
                {
                    account: ACCOUNT,
                },
            );
            expect(result).toEqual({ ok: true, value: { tag: "Bound", alias: ALIAS } });
        });

        test("a moved ring needs a revised proof for the binding's context", async () => {
            const result = await readPeopleAirdropsSigning(
                fakeChain({ alias: bound, rootRevision: 9 }),
                {
                    account: ACCOUNT,
                },
            );
            expect(result).toEqual({
                ok: true,
                value: { tag: "Revised", alias: ALIAS, aliasContext: CONTEXT, ring: 2 },
            });
        });

        test("a ring with no root cannot sign", async () => {
            const result = await readPeopleAirdropsSigning(fakeChain({ alias: bound }), {
                account: ACCOUNT,
            });
            expect(result).toEqual({ ok: true, value: { tag: "RingUnavailable", ring: 2 } });
        });
    });

    describe("peopleAirdropsRegisterCalls", () => {
        function registerChain(max: () => Promise<number>) {
            return {
                individuality: {
                    constants: { PeopleAirdrops: { MaxRegisterBatch: max } },
                    tx: {
                        PeopleAirdrops: {
                            register: (args: { event_ids: string[] }) => args.event_ids,
                        },
                    },
                },
            };
        }
        const ids = [0n, 1n, 2n, 3n, 4n].map((i) => peopleAirdropsEventId(i));

        test("chunks to MaxRegisterBatch and drops duplicates", async () => {
            const result = await peopleAirdropsRegisterCalls(
                registerChain(async () => 2),
                [...ids, ids[0] as string],
            );
            if (!result.ok) throw result.error;
            expect(result.value.map((c) => c.eventIds.length)).toEqual([2, 2, 1]);
            expect(result.value[0]?.tx).toEqual(ids.slice(0, 2));
        });

        test("falls back to the pallet default when the constant is missing", async () => {
            const result = await peopleAirdropsRegisterCalls(
                registerChain(async () => {
                    throw new Error("no such constant");
                }),
                ids,
            );
            if (!result.ok) throw result.error;
            expect(result.value).toHaveLength(1);
        });

        test("an empty list builds nothing", async () => {
            const result = await peopleAirdropsRegisterCalls(
                registerChain(async () => 2),
                [],
            );
            expect(result).toEqual({ ok: true, value: [] });
        });

        test("refuses an id that is not a PeopleAirdrops draw", async () => {
            const result = await peopleAirdropsRegisterCalls(
                registerChain(async () => 2),
                [GAME],
            );
            expect(result.ok).toBe(false);
        });
    });
}
