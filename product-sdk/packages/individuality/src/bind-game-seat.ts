// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Step 2 of game registration: bind the person's lite alias to the game
 * account, and the personhood facts the bind and the draws read.
 */
import { bytesToHex } from "@parity/product-sdk-utils";
import { err, normalizeError, ok, type Result } from "@parity/result";

import { buildLiteAliasBindTx, type LiteAliasBindChain } from "./bind-lite-alias.js";
import { ProductIndividualityError } from "./errors.js";
import type { CreateRingVRFProof, RingVRFProof } from "./origin-extension.js";
import { asRegistrationError, errorName, GameSeatBindError } from "./register-game-errors.js";
import type {
    BindGameSeatOutcome,
    GameRegistrationCapabilities,
    GameSeatBindChain,
    PersonhoodProver,
    PersonhoodRing,
    TxWatch,
} from "./register-game-types.js";
import { litePeopleRing, peopleRing, readScoreContext, type ScoreContextChain } from "./rings.js";
import { sameAccount } from "./same-account.js";
import { readLiteSignUpRequirement } from "./signup-lite.js";
import type { LiteSignUpBlocker } from "./signup-types.js";

/** The personhood rings on this chain, and whether a host can prove in them. */
export interface PersonhoodFacts {
    /** `Score.score_context` is the product derivation a host mints in. */
    derived: boolean;
    /** `peopl.<tld>`. */
    owner: string;
    lite: PersonhoodRing;
    full: PersonhoodRing;
}

export async function readPersonhoodFacts(
    chain: ScoreContextChain & Pick<LiteAliasBindChain, "raw">,
    tld: string,
    signal: AbortSignal | undefined,
): Promise<PersonhoodFacts> {
    const [score, spec] = await Promise.all([
        readScoreContext(chain, { tld, signal }),
        chain.raw.individuality.getChainSpecData(),
    ]);
    if (!score.ok) throw score.error;
    const genesis = spec.genesisHash as `0x${string}`;
    const owner = score.value.productId;
    return {
        derived: score.value.tag === "ProductDerived",
        owner,
        lite: { key: "lite", owner, ring: litePeopleRing(genesis) },
        full: { key: "full", owner, ring: peopleRing(genesis) },
    };
}

/** The lite proof the bind and a stale binding's re-point ride: the lite key, in the score context. */
export function liteProof(prover: PersonhoodProver, facts: PersonhoodFacts): CreateRingVRFProof {
    const context = { productId: facts.owner, suffix: { tag: "Index" as const, value: 0 } };
    return (message) => prover.prove(facts.lite, context, message);
}

/**
 * Whether this person can take the free route: the chain's score context is one
 * a host mints in, and the host holds their lite key.
 */
export async function holdsLiteKey(
    chain: ScoreContextChain & Pick<LiteAliasBindChain, "raw">,
    capabilities: Pick<GameRegistrationCapabilities, "personhood">,
    options: { tld: string; signal?: AbortSignal },
): Promise<Result<boolean, ProductIndividualityError>> {
    try {
        const prover = capabilities.personhood;
        if (!prover) return ok(false);
        const facts = await readPersonhoodFacts(chain, options.tld, options.signal);
        return ok(facts.derived && (await prover.holds(facts.lite)));
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

// ── submission of the raw bind ───────────────────────────────────────────────

/** Where a raw submission settled. */
type Settled = { ok: true } | { ok: false; error: string; landingUnknown?: boolean };

/** PAPI's words when a watch lost its blocks before the transaction's fate was known. */
function isTrackingStopped(error: unknown): boolean {
    return error instanceof Error && /tracking stopped/i.test(error.message);
}

/** How long the bind waits for a best block to hold it, from submission. */
const DEFAULT_BIND_TIMEOUT_MS = 120_000;

/**
 * Drive the bind's watch to the best block that holds it. Every ending settles,
 * never throws: a refusal, a watch that ends empty, or `Timeout` (landing
 * unknown) after `timeoutMs`. An abort counts only before the broadcast.
 */
function settleRaw(
    watch: TxWatch,
    signal?: AbortSignal,
    timeoutMs: number = DEFAULT_BIND_TIMEOUT_MS,
): Promise<Settled> {
    return new Promise<Settled>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        let settled = false;
        let broadcast = false;
        const timer = setTimeout(
            () => finish(() => resolve({ ok: false, error: "Timeout", landingUnknown: true })),
            timeoutMs,
        );
        // biome-ignore lint/style/useConst: PAPI can emit during `subscribe`, and `finish` reads `sub` then; a `const` would still be in its temporal dead zone.
        let sub: { unsubscribe(): void } | undefined;
        const finish = (done: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            sub?.unsubscribe();
            done();
        };
        const onAbort = () => {
            if (!broadcast) finish(() => reject(signal?.reason));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        sub = watch.subscribe({
            next: (event) => {
                if (event.type === "broadcasted") {
                    broadcast = true;
                    return;
                }
                if (event.type === "inBestBlock" || event.type === "finalized") {
                    finish(() =>
                        resolve(
                            event.ok
                                ? { ok: true }
                                : { ok: false, error: errorName(event.dispatchError) },
                        ),
                    );
                }
            },
            error: (error) =>
                finish(() =>
                    resolve({
                        ok: false,
                        error: errorName(error),
                        ...(isTrackingStopped(error) ? { landingUnknown: true } : {}),
                    }),
                ),
            complete: () =>
                finish(() =>
                    resolve({
                        ok: false,
                        error: "the watch ended before any block held the transaction",
                    }),
                ),
        });
        if (settled) sub.unsubscribe();
    });
}

// ── step 2: bind ─────────────────────────────────────────────────────────────

/** Options for {@link bindGameSeat}. */
export interface BindGameSeatOptions {
    tld: string;
    signal?: AbortSignal;
    /** How long to wait for a block to hold the bind. Default 120 000 ms, then `Timeout`. */
    timeoutMs?: number;
}

/** The reads and the submission the bind makes, swappable so its decisions can be tested alone. */
interface BindSteps {
    requirement(
        chain: GameSeatBindChain,
        account: string,
        tld: string,
        signal?: AbortSignal,
    ): Promise<{ blockers: readonly LiteSignUpBlocker[] }>;
    facts(chain: GameSeatBindChain, tld: string, signal?: AbortSignal): Promise<PersonhoodFacts>;
    build(
        chain: GameSeatBindChain,
        account: string,
        createProof: CreateRingVRFProof,
        signal?: AbortSignal,
    ): Promise<{ transaction: Uint8Array }>;
    pinnedTo(
        chain: GameSeatBindChain,
        alias: Uint8Array,
        signal?: AbortSignal,
    ): Promise<string | undefined>;
    submitRaw(
        chain: GameSeatBindChain,
        transaction: Uint8Array,
        signal?: AbortSignal,
        timeoutMs?: number,
    ): Promise<Settled>;
}

const BIND_STEPS: BindSteps = {
    async requirement(chain, account, tld, signal) {
        const read = await readLiteSignUpRequirement(chain, { account, tld, at: "best", signal });
        if (!read.ok) throw read.error;
        return read.value;
    },
    facts: readPersonhoodFacts,
    build: (chain, account, createProof, signal) =>
        buildLiteAliasBindTx(chain, { account, createProof, signal }),
    pinnedTo: (chain, alias, signal) =>
        chain.individuality.query.Game.LiteInvites.getValue(`0x${bytesToHex(alias)}`, {
            at: "best",
            signal,
        }),
    submitRaw: (chain, transaction, signal, timeoutMs) =>
        settleRaw(chain.raw.individuality.submitAndWatch(transaction), signal, timeoutMs),
};

/**
 * Bind the person's lite alias to the game account: `PeopleLite.set_alias_account`,
 * unsigned, carrying a proof from the personhood product's lite key in
 * `Score.score_context`. Resolves once a best block holds it.
 *
 * Reads before it builds, so a retry never binds twice:
 *
 * - A current binding resolves `already-bound`, asking for nothing. A stale one
 *   is bound again ({@link registerForGame} leaves that to the sign-up).
 * - A bind that cannot succeed is refused before any proof is asked for.
 * - Otherwise it proves, checks the `Game.LiteInvites` pin on the alias, and
 *   submits.
 *
 * A chain answer of `AliasAccountAlreadySet` (another bind landed first) is
 * `already-bound`. Fails with {@link GameSeatBindError}; check `permanent`.
 */
export async function bindGameSeat(
    chain: GameSeatBindChain,
    capabilities: Pick<GameRegistrationCapabilities, "account" | "personhood">,
    options: BindGameSeatOptions,
): Promise<Result<BindGameSeatOutcome, ProductIndividualityError>> {
    try {
        return ok(await runBind(chain, capabilities, options));
    } catch (cause) {
        return err(asRegistrationError("bind", cause));
    }
}

export async function runBind(
    chain: GameSeatBindChain,
    capabilities: Pick<GameRegistrationCapabilities, "account" | "personhood">,
    options: BindGameSeatOptions,
    known?: PersonhoodFacts,
    steps: BindSteps = BIND_STEPS,
): Promise<BindGameSeatOutcome> {
    const { signal, tld } = options;
    const account = capabilities.account.address;
    const { blockers } = await steps.requirement(chain, account, tld, signal);
    const has = (tag: LiteSignUpBlocker["tag"]) => blockers.some((blocker) => blocker.tag === tag);

    for (const tag of ["AccountIsALitePerson", "AliasBoundElsewhere"] as const) {
        if (has(tag)) throw new GameSeatBindError("dead-end", tag);
    }
    const invited = blockers.find((blocker) => blocker.tag === "AnotherAccountInvited");
    if (invited && "invited" in invited) {
        throw new GameSeatBindError("pinned-elsewhere", "AnotherAccountInvited", invited.invited);
    }
    if (has("ContextNotProductDerived")) {
        throw new GameSeatBindError("no-proof-context", "ContextNotProductDerived");
    }
    if (!has("AliasNotBound") && !has("StaleAlias")) return "already-bound";

    const facts = known ?? (await steps.facts(chain, tld, signal));
    if (!facts.derived) throw new GameSeatBindError("no-proof-context", "ContextNotProductDerived");
    const prover = capabilities.personhood;
    if (!prover) throw new GameSeatBindError("no-lite-key", "NoPersonhoodProver");

    let alias: Uint8Array | undefined;
    const prove = liteProof(prover, facts);
    const built = await steps.build(
        chain,
        account,
        async (message) => {
            const proof = await prove(message);
            alias = proof.contextualAlias.alias;
            return proof;
        },
        signal,
    );
    if (alias) {
        const pinned = await steps.pinnedTo(chain, alias, signal);
        if (pinned !== undefined && !sameAccount(pinned, account)) {
            throw new GameSeatBindError("pinned-elsewhere", "AnotherAccountInvited", pinned);
        }
    }
    signal?.throwIfAborted();
    const result = await steps.submitRaw(chain, built.transaction, signal, options.timeoutMs);
    if (result.ok) return "bound";
    if (result.error === "AliasAccountAlreadySet") return "already-bound";
    throw new GameSeatBindError("rejected", result.error, undefined, {
        landingUnknown: result.landingUnknown,
    });
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { unwrapErr } = await import("@parity/result");
    const { AccountId } = await import("polkadot-api");
    const { ADDRESS, FACTS, OTHER, PUBLIC_KEY, capabilities, tagged } = await import(
        "./register-game-harness.js"
    );

    describe("bind", () => {
        const BUILT = { transaction: new Uint8Array([1, 2, 3]) };
        const ALIAS = new Uint8Array(32).fill(9);
        const proofOf = async () =>
            ({
                proof: new Uint8Array(1),
                contextualAlias: { context: new Uint8Array(32), alias: ALIAS },
                ringIndex: 0,
                ringRevision: 0,
            }) as RingVRFProof;

        const bindSteps = (overrides: Partial<BindSteps> = {}) => {
            const submitRaw = vi.fn<BindSteps["submitRaw"]>(async () => ({ ok: true }));
            const steps: BindSteps = {
                requirement: async () => ({ blockers: tagged("AliasNotBound") }),
                facts: async () => FACTS,
                build: async (_chain, _account, createProof) => {
                    await createProof(new Uint8Array(32));
                    return BUILT;
                },
                pinnedTo: async () => undefined,
                submitRaw,
                ...overrides,
            };
            return { steps, submitRaw };
        };
        const prover = () => ({ holds: async () => true, prove: vi.fn(proofOf) });
        const bind = (personhood: PersonhoodProver | undefined, steps: BindSteps) =>
            runBind(
                {} as GameSeatBindChain,
                { account: { address: ADDRESS, publicKey: PUBLIC_KEY }, personhood },
                { tld: "paseo" },
                undefined,
                steps,
            );

        test("sends the bytes raw and resolves once a block holds the bind", async () => {
            const { steps, submitRaw } = bindSteps();
            expect(await bind(prover(), steps)).toBe("bound");
            expect(submitRaw).toHaveBeenCalledWith(
                expect.anything(),
                BUILT.transaction,
                undefined,
                undefined,
            );
        });

        test("resolves at once, asking for no proof, when the account is bound already", async () => {
            const personhood = prover();
            const { steps, submitRaw } = bindSteps({ requirement: async () => ({ blockers: [] }) });
            expect(await bind(personhood, steps)).toBe("already-bound");
            expect(personhood.prove).not.toHaveBeenCalled();
            expect(submitRaw).not.toHaveBeenCalled();
        });

        test("re-points a binding the ring moved past", async () => {
            const { steps, submitRaw } = bindSteps({
                requirement: async () => ({ blockers: tagged("StaleAlias") }),
            });
            expect(await bind(prover(), steps)).toBe("bound");
            expect(submitRaw).toHaveBeenCalledOnce();
        });

        test("refuses a bind that cannot succeed before asking for any proof", async () => {
            for (const tag of ["AccountIsALitePerson", "AliasBoundElsewhere"]) {
                const personhood = prover();
                const { steps, submitRaw } = bindSteps({
                    requirement: async () => ({ blockers: tagged(tag) }),
                });
                await expect(bind(personhood, steps)).rejects.toMatchObject({
                    refusal: "dead-end",
                    code: tag,
                    permanent: true,
                });
                expect(personhood.prove).not.toHaveBeenCalled();
                expect(submitRaw).not.toHaveBeenCalled();
            }
        });

        test("refuses before submitting when the person's free seat is pinned to another account", async () => {
            const { steps, submitRaw } = bindSteps({ pinnedTo: async () => OTHER });
            await expect(bind(prover(), steps)).rejects.toMatchObject({
                refusal: "pinned-elsewhere",
                account: OTHER,
                permanent: true,
            });
            expect(submitRaw).not.toHaveBeenCalled();
        });

        test("submits when the pin names this account, whatever prefix the chain spells it in", async () => {
            const polkadot = AccountId(0).dec(PUBLIC_KEY);
            const { steps, submitRaw } = bindSteps({ pinnedTo: async () => polkadot });
            expect(await bind(prover(), steps)).toBe("bound");
            expect(submitRaw).toHaveBeenCalledOnce();
        });

        test("a bind that lost the race to another one counts as bound", async () => {
            const { steps } = bindSteps({
                submitRaw: vi.fn(async () => ({
                    ok: false as const,
                    error: "AliasAccountAlreadySet",
                })),
            });
            expect(await bind(prover(), steps)).toBe("already-bound");
        });

        test("rejects with the chain's code, permanent only for the lasting refusals", async () => {
            const lasting = bindSteps({
                submitRaw: vi.fn(async () => ({ ok: false as const, error: "AccountInUse" })),
            });
            await expect(bind(prover(), lasting.steps)).rejects.toMatchObject({
                code: "AccountInUse",
                permanent: true,
            });
            const passing = bindSteps({
                submitRaw: vi.fn(async () => ({ ok: false as const, error: "BadProof" })),
            });
            await expect(bind(prover(), passing.steps)).rejects.toMatchObject({
                code: "BadProof",
                permanent: false,
                retryable: true,
            });
        });

        test("a bind no block held in time is retryable, and may still land", async () => {
            const { steps } = bindSteps({
                submitRaw: vi.fn(async () => ({
                    ok: false as const,
                    error: "Timeout",
                    landingUnknown: true,
                })),
            });
            await expect(bind(prover(), steps)).rejects.toMatchObject({
                code: "Timeout",
                retryable: true,
                landingUnknown: true,
            });
        });

        test("without a lite key it fails for good, submitting nothing", async () => {
            const { steps, submitRaw } = bindSteps();
            await expect(bind(undefined, steps)).rejects.toMatchObject({
                refusal: "no-lite-key",
                permanent: true,
            });
            expect(submitRaw).not.toHaveBeenCalled();
        });
    });

    describe("bindGameSeat", () => {
        test("reports a failed read on the err channel as a bind failure, and submits nothing", async () => {
            const submitAndWatch = vi.fn();
            const chain = {
                raw: { individuality: { submitAndWatch } },
            } as unknown as GameSeatBindChain;
            const result = await bindGameSeat(chain, capabilities(), { tld: "paseo" });
            expect(unwrapErr(result)).toMatchObject({
                name: "GameRegistrationError",
                stage: "bind",
            });
            expect(submitAndWatch).not.toHaveBeenCalled();
        });
    });

    describe("settleRaw", () => {
        const watch = (emit: (observer: Parameters<TxWatch["subscribe"]>[0]) => void): TxWatch => ({
            subscribe(observer) {
                emit(observer);
                return { unsubscribe() {} };
            },
        });

        test("resolves at the best block that holds the bind", async () => {
            const result = await settleRaw(
                watch((observer) => {
                    observer.next({ type: "broadcasted" });
                    observer.next({ type: "inBestBlock", ok: true });
                }),
            );
            expect(result).toEqual({ ok: true });
        });

        test("a watch that ends with no block is a failure, not a hang", async () => {
            const result = await settleRaw(
                watch((observer) => {
                    observer.next({ type: "broadcasted" });
                    observer.complete?.();
                }),
            );
            expect(result.ok).toBe(false);
        });

        test("a lost watch says the landing is unknown", async () => {
            const result = await settleRaw(
                watch((observer) => observer.error(new Error("tracking stopped"))),
            );
            expect(result).toMatchObject({ ok: false, landingUnknown: true });
        });

        test("a watch no block answers gives up at the deadline, and lets go of it", async () => {
            vi.useFakeTimers();
            try {
                const unsubscribe = vi.fn();
                const silent: TxWatch = {
                    subscribe(observer) {
                        observer.next({ type: "broadcasted" });
                        return { unsubscribe };
                    },
                };
                const settling = settleRaw(silent, undefined, 1_000);
                await vi.advanceTimersByTimeAsync(1_000);
                expect(await settling).toEqual({
                    ok: false,
                    error: "Timeout",
                    landingUnknown: true,
                });
                expect(unsubscribe).toHaveBeenCalledOnce();
            } finally {
                vi.useRealTimers();
            }
        });
    });
}
