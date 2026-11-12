// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Sign a player up for the weekly game in one call, from any product.
 * {@link registerForGame} runs four steps:
 *
 * 1. **Seat**: which route the player takes ({@link readGameSeat}). Already
 *    registered is success; a closed game or an unfunded account signs nothing.
 * 2. **Bind**: on the free route with no binding yet, {@link bindGameSeat}.
 * 3. **Draws**: the prize-draw entries. They never block the sign-up: without
 *    them it goes anyway, and says why.
 * 4. **Sign**: the call for the route, under the origin it needs, handed to the
 *    `submit` capability.
 *
 * Every step reads the chain first, so running the call again resumes where it
 * stopped. The host comes in as {@link GameRegistrationCapabilities}; the
 * `/host` entry builds them.
 *
 * Ported from jollity-next `packages/game-chain/src/engine.ts`.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { err, normalizeError, ok, type Result } from "@parity/result";

import { withLiteAlias } from "./as-lite-alias-signer.js";
import { withScoreParticipant } from "./as-score-participant-signer.js";
import {
    liteProof,
    readPersonhoodFacts,
    runBind,
    type BindGameSeatOptions,
    type PersonhoodFacts,
} from "./bind-game-seat.js";
import {
    decideDraws,
    entryCount,
    FIXED_BY_THE_SIGN_UP,
    type DrawEntries,
    type DrawRequirement,
} from "./draw-entries.js";
import { ProductIndividualityError } from "./errors.js";
import {
    asRegistrationError,
    errorDetail,
    errorName,
    GameRegistrationError,
    GameSeatBindError,
    NOT_RETRYABLE_SIGN_UP,
} from "./register-game-errors.js";
import type {
    BindGameSeatOutcome,
    DrawOutcome,
    GameRegistrationCapabilities,
    GameRegistrationChain,
    GameRegistrationReport,
    GameRegistrationStage,
    GameRegistrationStep,
    SignUpTransaction,
} from "./register-game-types.js";
import { chainNow, readGameSeat, type GameSeat, type SeatRoute } from "./seat.js";
import { readGameSignUpRequirement, signUpWithAccountTx } from "./signup.js";
import { readLiteSignUpRequirement, signUpWithLiteInviteTx } from "./signup-lite.js";

/** How long a sign-up waits for draws that are not open yet. */
export interface DrawWaitOptions {
    /** The longest wait. Default 20 000 ms. */
    maxMs?: number;
    /** How often to ask again. Default 2 000 ms, about a block. */
    retryMs?: number;
    /** Stop waiting this many seconds before registration closes. Default 15. */
    closingSeconds?: number;
}

const DEFAULT_DRAW_WAIT_MS = 20_000;
const DEFAULT_DRAW_RETRY_MS = 2_000;
const DEFAULT_DRAW_CLOSING_S = 15;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Asks `decide` for the draw entries again every `retryMs` while it says to
 * wait, until `maxMs` from `startedAt` or until `closing` says registration is
 * about to close. Giving up keeps the skip and says why.
 */
async function waitForDraws(
    decide: () => Promise<DrawEntries>,
    closing: () => Promise<boolean>,
    wait: { startedAt: number; maxMs: number; retryMs: number },
    signal: AbortSignal | undefined,
): Promise<{ draws: DrawEntries; retries: number }> {
    let retries = 0;
    let draws = await decide();
    while (draws.entries === undefined && draws.wait) {
        const isClosing = await closing();
        if (Date.now() - wait.startedAt >= wait.maxMs || isClosing) {
            const why = isClosing ? ": registration is closing" : "";
            return {
                draws: {
                    ...draws,
                    skipped: `${draws.skipped} (gave up waiting${why})`,
                    wait: false,
                    ...(isClosing ? { kind: "closing" as const } : {}),
                },
                retries,
            };
        }
        await sleep(wait.retryMs, signal);
        retries += 1;
        draws = await decide();
    }
    return { draws, retries };
}

/**
 * The signer, made to drop a signature that arrives after `signal` aborts. The
 * transaction goes out only with the signed bytes, so an abort while the signing
 * prompt is open sends nothing. Fee estimates (mocked signatures) pass through.
 */
function abortable(signer: CommonSignerTxCreator, signal: AbortSignal): CommonSignerTxCreator {
    const create = (...args: Parameters<CommonSignerTxCreator>): Promise<string> => {
        const [, , , mockedSignature] = args;
        if (mockedSignature) return signer(...args);
        if (signal.aborted) return Promise.reject(signal.reason);
        return new Promise<string>((resolve, reject) => {
            const onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            signer(...args)
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", onAbort));
        });
    };
    return Object.assign(create, {
        publicKey: signer.publicKey,
        signBytes: (data: Uint8Array) => signer.signBytes(data),
    }) as CommonSignerTxCreator;
}

// ── the flow ─────────────────────────────────────────────────────────────────

/** Options for {@link registerForGame}. */
export interface RegisterForGameOptions {
    /** The network's DotNS TLD, such as `"paseo"`. */
    tld: string;
    /** `CommunicationIdentifier`: the 65-byte P-256 key co-players reach this player with. */
    identifierKey: Uint8Array;
    /** A seat read moments ago, to skip reading it again. Never pass a cached one on a retry. */
    seat?: GameSeat;
    /** When the sign-up counts as done. Default `"best-block"`; `"finalized"` waits for finality. */
    waitFor?: "best-block" | "finalized";
    drawWait?: DrawWaitOptions;
    /** Passed to {@link readGameSeat}. */
    feeHeadroom?: number;
    /** Stops the flow up to the broadcast; after it, the sign-up may still land. */
    signal?: AbortSignal;
    onStage?(stage: GameRegistrationStage): void;
    onSeat?(seat: GameSeat): void;
    onDraws?(draws: DrawOutcome): void;
}

/** How {@link registerForGame} ended, when it did not fail. Every variant carries its report. */
export type RegisterForGameOutcome =
    | { kind: "registered"; route: SeatRoute; draws: DrawOutcome; report: GameRegistrationReport }
    /** Signed up already, by this product or another. */
    | { kind: "already-registered"; report: GameRegistrationReport }
    /** Registration is not open by the chain's clock: no game, or past its registration. */
    | { kind: "not-open"; seat: GameSeat; report: GameRegistrationReport }
    /** The deposit route, and the account cannot pay. Nothing was signed. */
    | { kind: "unfunded"; seat: GameSeat; missing: bigint; report: GameRegistrationReport };

/**
 * Sign the player up for the running game: seat, bind, draws, sign. Fails with a
 * {@link GameRegistrationError} naming the step, the code and whether a retry
 * can help; losing a race to another product is `already-registered`.
 */
export async function registerForGame(
    chain: GameRegistrationChain,
    capabilities: GameRegistrationCapabilities,
    options: RegisterForGameOptions,
): Promise<Result<RegisterForGameOutcome, ProductIndividualityError>> {
    try {
        return ok(await runRegistration(chain, capabilities, options, CHAIN_STEPS));
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/** The reads and the bind the flow makes, swappable so the flow's own decisions can be tested alone. */
interface RegistrationSteps {
    seat(
        chain: GameRegistrationChain,
        options: Parameters<typeof readGameSeat>[1],
    ): Promise<GameSeat>;
    bind(
        chain: GameRegistrationChain,
        capabilities: GameRegistrationCapabilities,
        options: BindGameSeatOptions,
        facts: PersonhoodFacts,
    ): Promise<BindGameSeatOutcome>;
    requirement(
        chain: GameRegistrationChain,
        route: SeatRoute,
        options: { account: string; tld: string; now: number; signal?: AbortSignal },
    ): Promise<DrawRequirement>;
    facts(
        chain: GameRegistrationChain,
        tld: string,
        signal?: AbortSignal,
    ): Promise<PersonhoodFacts>;
    now(chain: GameRegistrationChain, signal?: AbortSignal): Promise<number>;
    draws(
        chain: GameRegistrationChain,
        capabilities: GameRegistrationCapabilities,
        requirement: DrawRequirement,
        tld: string,
        facts: () => Promise<PersonhoodFacts>,
        signal: AbortSignal | undefined,
    ): Promise<DrawEntries>;
}

const CHAIN_STEPS: RegistrationSteps = {
    async seat(chain, options) {
        const seat = await readGameSeat(chain, options);
        if (!seat.ok) throw seat.error;
        return seat.value;
    },
    bind: (chain, capabilities, options, facts) => runBind(chain, capabilities, options, facts),
    async requirement(chain, route, { account, tld, now, signal }) {
        // Both at the best block, judged by the chain's clock: a bind that just
        // landed is not final yet, and a phone's clock can be minutes off.
        const read =
            route === "free"
                ? await readLiteSignUpRequirement(chain, { account, tld, at: "best", now, signal })
                : await readGameSignUpRequirement(chain, {
                      registrant: { tag: "Account", accountAddress: account },
                      keyType: "sr25519",
                      at: "best",
                      now,
                      signal,
                  });
        if (!read.ok) throw read.error;
        return read.value;
    },
    facts: readPersonhoodFacts,
    now: chainNow,
    draws: decideDraws,
};

async function runRegistration(
    chain: GameRegistrationChain,
    capabilities: GameRegistrationCapabilities,
    options: RegisterForGameOptions,
    steps: RegistrationSteps,
): Promise<RegisterForGameOutcome> {
    const { tld, signal } = options;
    const account = capabilities.account.address;
    const report: GameRegistrationReport = { steps: {} };
    let current: GameRegistrationStep = "seat";
    const begin = (step: GameRegistrationStep) => {
        current = step;
        report.steps[step] = { startedAt: Date.now() };
        options.onStage?.(step);
    };
    const end = (step: GameRegistrationStep) => {
        const entry = report.steps[step];
        if (entry) entry.endedAt = Date.now();
    };

    try {
        return await flow();
    } catch (error) {
        const failure = asRegistrationError(current, error);
        failure.report = report;
        throw failure;
    }

    async function flow(): Promise<RegisterForGameOutcome> {
        let factsRead: Promise<PersonhoodFacts> | undefined;
        const facts = () => {
            factsRead ??= steps.facts(chain, tld, signal);
            factsRead.catch(() => {
                factsRead = undefined;
            });
            return factsRead;
        };
        const recordSeat = (seat: GameSeat) => {
            report.seat = {
                path: seat.path,
                ready: seat.ready,
                registered: seat.registered,
                open: seat.open,
            };
            options.onSeat?.(seat);
        };
        const readSeat = (litePerson: boolean) =>
            steps.seat(chain, {
                account,
                litePerson,
                tld,
                feeHeadroom: options.feeHeadroom,
                signal,
            });

        // ── 1. seat
        begin("seat");
        let seat = options.seat;
        if (!seat) {
            let litePerson = false;
            if (capabilities.personhood) {
                try {
                    const personhood = await facts();
                    litePerson =
                        personhood.derived &&
                        (await capabilities.personhood.holds(personhood.lite));
                } catch (error) {
                    signal?.throwIfAborted();
                    // A host that cannot list the keys (no grant, not connected)
                    // closes the free route, never the others.
                    report.liteKeyLookupFailed = errorName(error);
                }
            }
            seat = await readSeat(litePerson);
        }
        recordSeat(seat);
        end("seat");
        if (seat.registered) return { kind: "already-registered", report };
        if (!seat.open) return { kind: "not-open", seat, report };

        // ── 2. bind
        if (seat.path === "free" && !seat.ready) {
            begin("bind");
            try {
                const outcome = await steps.bind(
                    chain,
                    capabilities,
                    { tld, signal },
                    await facts(),
                );
                report.bind = { outcome };
                seat = { ...seat, ready: true };
            } catch (error) {
                if (!(error instanceof GameSeatBindError) || !error.permanent) throw error;
                report.bind = {
                    outcome: "refused",
                    refusal: error.refusal,
                    code: error.code,
                    permanent: true,
                };
                // The lite route is closed for this account: seat the player like anyone else.
                seat = await readSeat(false);
                recordSeat(seat);
            }
            end("bind");
            // The bind can take a while (the proof prompt): the game may have closed,
            // or another product signed the player up, in the meantime.
            if (seat.registered) return { kind: "already-registered", report };
            if (!seat.open) return { kind: "not-open", seat, report };
        }
        if (seat.path === "unfunded") {
            return { kind: "unfunded", seat, missing: seat.required - seat.funds.free, report };
        }
        const route = seat.path;
        report.route = route;

        // ── 3. draws
        begin("draws");
        const wait = options.drawWait ?? {};
        const maxMs = wait.maxMs ?? DEFAULT_DRAW_WAIT_MS;
        const retryMs = wait.retryMs ?? DEFAULT_DRAW_RETRY_MS;
        const closingSeconds = wait.closingSeconds ?? DEFAULT_DRAW_CLOSING_S;
        const startedAt = Date.now();
        // The origin the route signs under; a read below may revise it (a stale binding).
        let signer =
            route === "free"
                ? withLiteAlias(capabilities.signer, { tag: "AliasWithAccount" })
                : route === "returning"
                  ? withScoreParticipant(capabilities.signer)
                  : capabilities.signer;
        let registrationEnds: number | null = null;
        let scheduled = 0;

        const decide = async (): Promise<DrawEntries> => {
            let requirement: DrawRequirement;
            try {
                const now = await steps.now(chain, signal);
                requirement = await steps.requirement(chain, route, {
                    account,
                    tld,
                    now,
                    signal,
                });
            } catch (error) {
                signal?.throwIfAborted();
                // The draws never block the sign-up: wait a block and ask again,
                // and if the read does not come back, sign up without tickets.
                return {
                    skipped: `the sign-up requirement could not be read: ${errorName(error)}`,
                    scheduled,
                    wait: true,
                    kind: "read-failed",
                };
            }
            registrationEnds = requirement.registrationEnds;
            scheduled = requirement.airdropsScheduled;
            if (route === "free") {
                const stale = requirement.blockers.some((blocker) => blocker.tag === "StaleAlias");
                if (stale && !capabilities.personhood) {
                    throw new GameRegistrationError("draws", "StaleAliasNeedsLiteKey", {
                        retryable: false,
                        message:
                            "the binding is stale, and nothing here can make the proof that re-points it",
                    });
                }
                // The re-point's proof is made when the signer asks for it, so
                // the personhood read it needs can only fail the sign step,
                // never the draws.
                const prover = capabilities.personhood;
                signer = withLiteAlias(
                    capabilities.signer,
                    stale && prover
                        ? {
                              tag: "AliasWithAccountRevised",
                              createProof: async (message) =>
                                  liteProof(prover, await facts())(message),
                          }
                        : { tag: "AliasWithAccount" },
                );
                const blockers = requirement.blockers.filter(
                    (blocker) => !FIXED_BY_THE_SIGN_UP.has(blocker.tag),
                );
                return steps.draws(
                    chain,
                    capabilities,
                    { ...requirement, blockers },
                    tld,
                    facts,
                    signal,
                );
            }
            signer =
                route === "returning"
                    ? withScoreParticipant(capabilities.signer)
                    : capabilities.signer;
            return steps.draws(chain, capabilities, requirement, tld, facts, signal);
        };

        const closing = async () => {
            if (registrationEnds === null) return false;
            try {
                return (await steps.now(chain, signal)) + closingSeconds >= registrationEnds;
            } catch {
                return false;
            }
        };

        const { draws, retries } = await waitForDraws(
            decide,
            closing,
            { startedAt, maxMs, retryMs },
            signal,
        );
        // An abort during the minting comes back as a skip; it is an abort.
        signal?.throwIfAborted();
        const outcome: DrawOutcome = {
            entered: draws.entries ? entryCount(draws.entries) : 0,
            scheduled: draws.scheduled,
            ...(draws.entries === undefined ? { skipped: draws.skipped, kind: draws.kind } : {}),
            waitedMs: Date.now() - startedAt,
            retries,
        };
        report.draws = outcome;
        options.onDraws?.(outcome);
        end("draws");

        // ── 4. sign
        begin("sign");
        signal?.throwIfAborted();
        let tx: SignUpTransaction;
        try {
            tx =
                route === "free"
                    ? signUpWithLiteInviteTx<SignUpTransaction>(chain, {
                          account,
                          identifierKey: options.identifierKey,
                          airdrops: draws.entries,
                          airdropsScheduled: draws.scheduled,
                      })
                    : signUpWithAccountTx<SignUpTransaction>(chain, {
                          identifierKey: options.identifierKey,
                          airdrops: draws.entries,
                          airdropsScheduled: draws.scheduled,
                      });
        } catch (error) {
            throw new GameRegistrationError("sign", "InvalidSignUp", {
                retryable: false,
                detail: errorDetail(error),
                cause: error,
            });
        }
        const result = await capabilities.submit(tx, signal ? abortable(signer, signal) : signer, {
            waitFor: options.waitFor ?? "best-block",
            onBroadcast: () => {
                report.broadcastAt = Date.now();
                options.onStage?.("broadcast");
            },
            ...(signal ? { signal } : {}),
        });
        end("sign");
        // A signature dropped by the abort reads as a refusal to the submitter; it is
        // an abort, and nothing went out.
        if (!result.ok && report.broadcastAt === undefined) signal?.throwIfAborted();
        if (!result.ok) {
            // Another product may have signed the same account up a moment earlier.
            if (result.code === "AlreadyRegistered") {
                report.signUp = { outcome: "already-registered" };
                return { kind: "already-registered", report };
            }
            report.signUp = {
                outcome: "failed",
                code: result.code,
                ...(result.message ? { message: result.message } : {}),
                ...(result.landingUnknown ? { landingUnknown: true } : {}),
            };
            throw new GameRegistrationError("sign", result.code, {
                retryable: result.refused !== true && !NOT_RETRYABLE_SIGN_UP.has(result.code),
                landingUnknown: result.landingUnknown,
                detail: result.message,
                cause: result.cause,
            });
        }
        report.signUp = { outcome: "registered" };
        return { kind: "registered", route, draws: outcome, report };
    }
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { unwrapErr } = await import("@parity/result");
    const {
        FACTS,
        IDENTIFIER,
        OTHER,
        PUBLIC_KEY,
        TICKET,
        baseSigner,
        capabilities,
        drawRequirement,
        fakeSubmit,
        tagged,
    } = await import("./register-game-harness.js");
    type SubmitSignUp = import("./register-game-types.js").SubmitSignUp;

    const seatOf = (overrides: Partial<GameSeat> = {}): GameSeat =>
        ({
            path: "deposit",
            ready: true,
            registered: false,
            open: true,
            required: 10n,
            requirement: { blockers: [] },
            funds: { free: 100n, deposit: 10n, estimatedFee: 0n },
            ...overrides,
        }) as GameSeat;

    /** A chain whose sign-up calls are named, so a test can tell which was built. */
    const fakeChain = () => {
        const tx = (call: string) => ({ call }) as unknown as SignUpTransaction;
        return {
            individuality: {
                tx: {
                    Game: {
                        sign_up_with_account: () => tx("sign_up_with_account"),
                        sign_up_with_account_lite_invite: () =>
                            tx("sign_up_with_account_lite_invite"),
                    },
                },
            },
        } as unknown as GameRegistrationChain;
    };

    const steps = (overrides: Partial<RegistrationSteps> = {}): RegistrationSteps => ({
        seat: async () => seatOf(),
        bind: async () => "bound",
        requirement: async () => drawRequirement(),
        facts: async () => FACTS,
        now: async () => 1_000,
        draws: async () => ({ skipped: "the game has no prize draw", scheduled: 0 }),
        ...overrides,
    });

    const run = (
        caps: GameRegistrationCapabilities,
        stepOverrides: Partial<RegistrationSteps> = {},
        options: Partial<RegisterForGameOptions> = {},
    ) =>
        runRegistration(
            fakeChain(),
            caps,
            { tld: "paseo", identifierKey: IDENTIFIER, ...options },
            steps(stepOverrides),
        );

    const failure = async (promise: Promise<unknown>) => {
        try {
            await promise;
        } catch (error) {
            return error as GameRegistrationError & Partial<GameSeatBindError>;
        }
        throw new Error("expected the flow to fail");
    };

    describe("registerForGame: the seat decides", () => {
        test("a registered account is success, nothing is signed, and the report says why", async () => {
            const { submit, calls } = fakeSubmit();
            const outcome = await run(capabilities({ submit }), {
                seat: async () => seatOf({ registered: true }),
            });
            expect(outcome.kind).toBe("already-registered");
            expect(outcome.report.seat).toMatchObject({ registered: true });
            expect(calls).toEqual([]);
        });

        test("a closed registration ends without signing", async () => {
            const { submit, calls } = fakeSubmit();
            const outcome = await run(capabilities({ submit }), {
                seat: async () => seatOf({ open: false }),
            });
            expect(outcome.kind).toBe("not-open");
            expect(calls).toEqual([]);
        });

        test("an account that cannot pay says how much is missing", async () => {
            const { submit, calls } = fakeSubmit();
            const outcome = await run(capabilities({ submit }), {
                seat: async () =>
                    seatOf({
                        path: "unfunded",
                        required: 30n,
                        funds: { free: 12n } as GameSeat["funds"],
                    }),
            });
            expect(outcome).toMatchObject({ kind: "unfunded", missing: 18n });
            expect(calls).toEqual([]);
        });

        test("a host that cannot list the lite keys closes only the free route", async () => {
            const { submit, calls } = fakeSubmit();
            const seat = vi.fn(async () => seatOf());
            const personhood = {
                holds: async () => {
                    throw new Error("Rejected");
                },
                prove: vi.fn(),
            };
            const outcome = await run(capabilities({ submit, personhood }), { seat });
            expect(seat).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ litePerson: false }),
            );
            expect(outcome).toMatchObject({ kind: "registered", route: "deposit" });
            expect(outcome.report.liteKeyLookupFailed).toBe("HostRefused");
            expect(calls).toHaveLength(1);
        });

        test("a seat read that fails is a retryable failure of the seat step, with the report", async () => {
            const error = await failure(
                run(capabilities(), {
                    seat: async () => {
                        throw new Error("socket closed");
                    },
                }),
            );
            expect(error).toBeInstanceOf(GameRegistrationError);
            expect(error).toMatchObject({ stage: "seat", retryable: true });
            expect(error.report?.steps.seat?.startedAt).toBeTypeOf("number");
        });
    });

    describe("registerForGame: the route picks the call and the signer", () => {
        test("deposit submits the account call with the plain signer, at the best block by default", async () => {
            const { submit, calls } = fakeSubmit();
            const outcome = await run(capabilities({ submit }));
            expect(outcome).toMatchObject({ kind: "registered", route: "deposit" });
            expect(calls).toHaveLength(1);
            expect(calls[0]!.call).toBe("sign_up_with_account");
            expect(calls[0]!.signer).toBe(baseSigner);
            expect(calls[0]!.options.waitFor).toBe("best-block");
        });

        test("returning wraps the signer for the fee-free participant origin", async () => {
            const { submit, calls } = fakeSubmit();
            await run(capabilities({ submit }), {
                seat: async () => seatOf({ path: "returning" }),
            });
            expect(calls[0]!.call).toBe("sign_up_with_account");
            expect(calls[0]!.signer).not.toBe(baseSigner);
        });

        test("free submits the lite invite call under the lite alias", async () => {
            const { submit, calls } = fakeSubmit();
            const personhood = { holds: async () => true, prove: vi.fn() };
            await run(capabilities({ submit, personhood }), {
                seat: async () => seatOf({ path: "free" }),
            });
            expect(calls[0]!.call).toBe("sign_up_with_account_lite_invite");
            expect(calls[0]!.signer).not.toBe(baseSigner);
        });

        test("a stale binding with no lite key fails the draws step, not retryable", async () => {
            const error = await failure(
                run(capabilities(), {
                    seat: async () => seatOf({ path: "free" }),
                    requirement: async () => drawRequirement({ blockers: tagged("StaleAlias") }),
                }),
            );
            expect(error).toMatchObject({
                stage: "draws",
                code: "StaleAliasNeedsLiteKey",
                retryable: false,
            });
        });

        test("a stale binding asks for its proof only when signing, so a failed personhood read never fails the draws", async () => {
            const facts = vi.fn(async (): Promise<PersonhoodFacts> => {
                throw new Error("score context unreadable");
            });
            const onDraws = vi.fn();
            const { submit, calls } = fakeSubmit();
            const personhood = { holds: async () => true, prove: vi.fn() };
            const outcome = await run(
                capabilities({ submit, personhood }),
                {
                    seat: async () => seatOf({ path: "free" }),
                    requirement: async () => drawRequirement({ blockers: tagged("StaleAlias") }),
                    facts,
                },
                { onDraws },
            );
            expect(onDraws).toHaveBeenCalledOnce();
            expect(outcome.kind).toBe("registered");
            // read once by the seat step's lite-key check (absorbed there), never by the
            // draws: the fake submit never signs, so the proof's own read never ran
            expect(facts).toHaveBeenCalledOnce();
            expect(outcome.report.liteKeyLookupFailed).toBeDefined();
            expect(calls[0]!.call).toBe("sign_up_with_account_lite_invite");
        });

        test("reads the requirement by the chain's clock", async () => {
            const requirement = vi.fn(async () => drawRequirement());
            await run(capabilities(), { now: async () => 4_242, requirement });
            expect(requirement).toHaveBeenCalledWith(
                expect.anything(),
                "deposit",
                expect.objectContaining({ now: 4_242 }),
            );
        });
    });

    describe("registerForGame: the bind", () => {
        const personhood = { holds: async () => true, prove: vi.fn() };

        test("binds an unbound free seat before signing up, and reports each stage", async () => {
            const { submit, calls } = fakeSubmit();
            const bind = vi.fn(async () => "bound" as const);
            const stages: string[] = [];
            const outcome = await run(
                capabilities({ submit, personhood }),
                { seat: async () => seatOf({ path: "free", ready: false }), bind },
                { onStage: (stage) => stages.push(stage) },
            );
            expect(bind).toHaveBeenCalledOnce();
            expect(calls[0]!.call).toBe("sign_up_with_account_lite_invite");
            expect(stages).toEqual(["seat", "bind", "draws", "sign", "broadcast"]);
            expect(outcome.report.bind).toEqual({ outcome: "bound" });
            expect(outcome.report.broadcastAt).toBeTypeOf("number");
        });

        test("a bind refused for good seats the player on the account route", async () => {
            const { submit, calls } = fakeSubmit();
            const seats = [seatOf({ path: "free", ready: false }), seatOf({ path: "deposit" })];
            const seat = vi.fn(async () => seats.shift()!);
            const outcome = await run(capabilities({ submit, personhood }), {
                seat,
                bind: async () => {
                    throw new GameSeatBindError("pinned-elsewhere", "AnotherAccountInvited", OTHER);
                },
            });
            expect(seat).toHaveBeenLastCalledWith(
                expect.anything(),
                expect.objectContaining({ litePerson: false }),
            );
            expect(outcome).toMatchObject({ kind: "registered", route: "deposit" });
            expect(outcome.report.bind).toMatchObject({
                outcome: "refused",
                refusal: "pinned-elsewhere",
            });
            expect(calls[0]!.call).toBe("sign_up_with_account");
        });

        test("after a refused bind, a seat that is now registered or closed signs nothing", async () => {
            for (const [after, kind] of [
                [seatOf({ registered: true }), "already-registered"],
                [seatOf({ open: false }), "not-open"],
            ] as const) {
                const { submit, calls } = fakeSubmit();
                const seats = [seatOf({ path: "free", ready: false }), after];
                const outcome = await run(capabilities({ submit, personhood }), {
                    seat: async () => seats.shift()!,
                    bind: async () => {
                        throw new GameSeatBindError("dead-end", "AliasBoundElsewhere");
                    },
                });
                expect(outcome.kind).toBe(kind);
                expect(calls).toEqual([]);
            }
        });

        test("a bind that may pass next time fails the bind step, retryable", async () => {
            const { submit, calls } = fakeSubmit();
            const error = await failure(
                run(capabilities({ submit, personhood }), {
                    seat: async () => seatOf({ path: "free", ready: false }),
                    bind: async () => {
                        throw new GameSeatBindError("rejected", "CallBlockOutOfRange");
                    },
                }),
            );
            expect(error).toMatchObject({ stage: "bind", retryable: true, permanent: false });
            expect(error.report?.steps.bind).toBeDefined();
            expect(calls).toEqual([]);
        });
    });

    describe("registerForGame: the sign-up's result", () => {
        test("losing a race to another product is success", async () => {
            const { submit } = fakeSubmit({ ok: false, code: "AlreadyRegistered" });
            const outcome = await run(capabilities({ submit }));
            expect(outcome.kind).toBe("already-registered");
            expect(outcome.report.signUp).toEqual({ outcome: "already-registered" });
        });

        test("a closed registration fails the sign step, not retryable", async () => {
            const { submit } = fakeSubmit({ ok: false, code: "NoRegistration" });
            const error = await failure(run(capabilities({ submit })));
            expect(error).toMatchObject({
                stage: "sign",
                code: "NoRegistration",
                retryable: false,
            });
            expect(error.report?.signUp).toMatchObject({
                outcome: "failed",
                code: "NoRegistration",
            });
        });

        test("a declined signature is never retryable", async () => {
            const { submit } = fakeSubmit({ ok: false, code: "SigningRejected", refused: true });
            const error = await failure(run(capabilities({ submit })));
            expect(error).toMatchObject({ stage: "sign", retryable: false });
        });

        test("a lost watch is retryable and says the landing is unknown", async () => {
            const { submit } = fakeSubmit({ ok: false, code: "Timeout", landingUnknown: true });
            const error = await failure(run(capabilities({ submit })));
            expect(error).toMatchObject({ stage: "sign", retryable: true, landingUnknown: true });
        });

        /** A signer that signs only once `release` is called. */
        const slowSigner = () => {
            let release!: () => void;
            const signed = new Promise<void>((resolve) => {
                release = resolve;
            });
            const signer = Object.assign(
                async () => {
                    await signed;
                    return "0x51";
                },
                { publicKey: PUBLIC_KEY, signBytes: async () => new Uint8Array(64) },
            ) as unknown as CommonSignerTxCreator;
            return { signer, release };
        };
        /** A `submit` that broadcasts only what its signer hands back, as `tx` does. */
        const signingSubmit = (onSigning: () => void): SubmitSignUp => {
            return async (_tx, signer, options) => {
                const signing = signer({} as never, {} as never, {} as never, false);
                onSigning();
                try {
                    await signing;
                } catch {
                    return { ok: false, code: "SigningRejected", refused: true };
                }
                options.onBroadcast?.();
                return { ok: true };
            };
        };

        test("an abort while the signature is being made sends nothing, and is an abort", async () => {
            const abort = new AbortController();
            const { signer, release } = slowSigner();
            const stages: string[] = [];
            const submit = signingSubmit(() => {
                abort.abort();
                release();
            });
            const error = await failure(
                run(
                    capabilities({ signer, submit }),
                    {},
                    {
                        signal: abort.signal,
                        onStage: (stage) => stages.push(stage),
                    },
                ),
            );
            expect(error).toMatchObject({ stage: "sign", code: "Aborted", retryable: true });
            expect(stages).not.toContain("broadcast");
            expect(error.report?.broadcastAt).toBeUndefined();
        });

        test("an abort after the broadcast is ignored: the sign-up may land", async () => {
            const abort = new AbortController();
            const submit: SubmitSignUp = async (_tx, _signer, options) => {
                options.onBroadcast?.();
                abort.abort();
                return { ok: true };
            };
            const outcome = await run(capabilities({ submit }), {}, { signal: abort.signal });
            expect(outcome.kind).toBe("registered");
        });

        test("hands the submitter the caller's signal", async () => {
            const { submit, calls } = fakeSubmit();
            const abort = new AbortController();
            await run(capabilities({ submit }), {}, { signal: abort.signal });
            expect(calls[0]!.options.signal).toBe(abort.signal);
        });

        test("a failed sign-up keeps its code a name, and what the host said in the message and report", async () => {
            const cause = new Error("WebSocket closed at 0x12…");
            const { submit } = fakeSubmit({
                ok: false,
                code: "Network",
                message: "WebSocket closed at 0x12…",
                cause,
            });
            const error = await failure(run(capabilities({ submit })));
            expect(error).toMatchObject({ stage: "sign", code: "Network", retryable: true });
            expect(error.message).toContain("WebSocket closed at 0x12…");
            expect(error.cause).toBe(cause);
            expect(error.report?.signUp).toMatchObject({
                outcome: "failed",
                code: "Network",
                message: "WebSocket closed at 0x12…",
            });
        });

        test("passes waitFor through when asked", async () => {
            const { submit, calls } = fakeSubmit();
            await run(capabilities({ submit }), {}, { waitFor: "finalized" });
            expect(calls[0]!.options.waitFor).toBe("finalized");
        });
    });

    describe("registerForGame: the draw wait", () => {
        test("waits a block for a draw that is not open, then carries the tickets", async () => {
            const { submit } = fakeSubmit();
            const answers: DrawEntries[] = [
                {
                    skipped: "draw #0 is not taking entries yet",
                    scheduled: 1,
                    wait: true,
                    kind: "not-open",
                },
                { entries: [TICKET], scheduled: 1 },
            ];
            const draws = vi.fn(async () => answers.shift()!);
            const outcome = await run(
                capabilities({ submit }),
                { draws },
                { drawWait: { retryMs: 1 } },
            );
            expect(draws).toHaveBeenCalledTimes(2);
            expect(outcome).toMatchObject({
                kind: "registered",
                draws: { entered: 1, retries: 1 },
            });
        });

        test("goes without tickets once the wait runs out, and still signs up", async () => {
            const { submit, calls } = fakeSubmit();
            const outcome = await run(
                capabilities({ submit }),
                {
                    draws: async () => ({
                        skipped: "draw #0 is not taking entries yet",
                        scheduled: 1,
                        wait: true,
                        kind: "not-open",
                    }),
                },
                { drawWait: { maxMs: 0, retryMs: 1 } },
            );
            expect(outcome).toMatchObject({ draws: { entered: 0, kind: "not-open" } });
            expect(outcome.kind === "registered" && outcome.draws.skipped).toContain(
                "gave up waiting",
            );
            expect(calls).toHaveLength(1);
        });

        test("a requirement read that fails waits a block and asks again", async () => {
            const { submit } = fakeSubmit();
            const reads = [
                async (): Promise<DrawRequirement> => {
                    throw new Error("socket closed");
                },
                async () => drawRequirement(),
            ];
            const draws = vi.fn(
                async (): Promise<DrawEntries> => ({ entries: [TICKET], scheduled: 1 }),
            );
            const outcome = await run(
                capabilities({ submit }),
                { requirement: () => reads.shift()!(), draws },
                { drawWait: { retryMs: 1 } },
            );
            expect(draws).toHaveBeenCalledOnce();
            expect(outcome).toMatchObject({
                kind: "registered",
                draws: { entered: 1, retries: 1 },
            });
        });

        test("a requirement that cannot be read costs the tickets, never the sign-up", async () => {
            const { submit, calls } = fakeSubmit();
            const personhood = { holds: async () => true, prove: vi.fn() };
            const outcome = await run(
                capabilities({ submit, personhood }),
                {
                    seat: async () => seatOf({ path: "free" }),
                    requirement: async () => {
                        throw new Error("socket closed");
                    },
                },
                { drawWait: { maxMs: 0, retryMs: 1 } },
            );
            expect(outcome).toMatchObject({
                kind: "registered",
                draws: { entered: 0, kind: "read-failed" },
            });
            // the free route still signs under the lite alias
            expect(calls[0]!.call).toBe("sign_up_with_account_lite_invite");
            expect(calls[0]!.signer).not.toBe(baseSigner);
        });

        test("an abort while the tickets are minted fails the draws step, with no draw outcome", async () => {
            const abort = new AbortController();
            const onDraws = vi.fn();
            const { submit, calls } = fakeSubmit();
            const error = await failure(
                run(
                    capabilities({ submit }),
                    {
                        draws: async () => {
                            abort.abort();
                            return {
                                skipped: "the tickets were not signed",
                                scheduled: 1,
                                kind: "signature",
                            };
                        },
                    },
                    { signal: abort.signal, onDraws },
                ),
            );
            expect(error).toMatchObject({ stage: "draws", code: "Aborted" });
            expect(onDraws).not.toHaveBeenCalled();
            expect(calls).toEqual([]);
        });

        test("never waits into the last seconds of registration, by the chain's clock", async () => {
            const { submit } = fakeSubmit();
            const draws = vi.fn(
                async (): Promise<DrawEntries> => ({
                    skipped: "draw #0 is not taking entries yet",
                    scheduled: 1,
                    wait: true,
                    kind: "not-open",
                }),
            );
            const outcome = await run(
                capabilities({ submit }),
                {
                    draws,
                    now: async () => 1_990,
                    requirement: async () => drawRequirement({ registrationEnds: 2_000 }),
                },
                { drawWait: { retryMs: 1 } },
            );
            expect(draws).toHaveBeenCalledOnce();
            expect(outcome).toMatchObject({ draws: { kind: "closing" } });
        });
    });

    test("registerForGame reports a failed seat read on the err channel, with its step", async () => {
        const result = await registerForGame({} as GameRegistrationChain, capabilities(), {
            tld: "paseo",
            identifierKey: IDENTIFIER,
        });
        expect(unwrapErr(result)).toMatchObject({ name: "GameRegistrationError", stage: "seat" });
    });
}
