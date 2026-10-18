// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Sign a player up for the weekly game in one call, from any product: the game's
 * own app and chat worker, or the personhood product.
 *
 * {@link registerForGame} runs the steps in order:
 *
 * 1. **Seat.** Read which route the player takes ({@link readGameSeat}), judged
 *    by the chain's clock. Already registered is success; a closed registration
 *    or an account that cannot pay ends here with nothing signed.
 * 2. **Bind.** On the free route with no binding yet, bind the person's lite
 *    alias to the game account ({@link bindGameSeat}). A bind the chain will
 *    refuse for good closes the lite route, and the seat is read again without it.
 * 3. **Draws.** Decide the prize-draw entries from the sign-up requirement at the
 *    best block, waiting a block at a time for a draw that is not open yet.
 *    Entries can only ride the sign-up, so a sign-up never waits on them for
 *    good: it goes without them, and says why.
 * 4. **Sign.** Build the call for the route, wrap the signer for the origin the
 *    route needs, and hand both to the `submit` capability.
 *
 * Every step reads the chain before it acts, so running the call again resumes
 * where the last one stopped: a bind that landed is not sent again, and a
 * sign-up that landed comes back as `already-registered`. Every outcome and
 * every {@link GameRegistrationError} carries a {@link GameRegistrationReport}
 * for the product's telemetry.
 *
 * Everything a host does comes in through {@link GameRegistrationCapabilities},
 * so this module imports neither `@parity/product-sdk-host` nor
 * `@parity/product-sdk-tx`. The `@parity/product-sdk-individuality/host` entry
 * builds the capabilities from a host, submitting with `tx`'s `submitAndWatch`.
 *
 * Ported from jollity-next `packages/game-chain/src/engine.ts` (`bind`,
 * `register`, `decideDraws`), where the game's app and chat worker shared it.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { bytesToHex } from "@parity/product-sdk-utils";
import { err, normalizeError, ok, type Result } from "@parity/result";

import { airdropPhase, statusTag } from "./airdrop-decode.js";
import type { AirdropChain } from "./airdrop-read.js";
import { withLiteAlias } from "./as-lite-alias-signer.js";
import { withScoreParticipant } from "./as-score-participant-signer.js";
import { buildLiteAliasBindTx, type LiteAliasBindChain } from "./bind-lite-alias.js";
import { ProductIndividualityError } from "./errors.js";
import { gameProductId } from "./game-account.js";
import type { GameChain } from "./game-read.js";
import type { CreateRingVRFProof, RingVRFProof } from "./origin-extension.js";
import {
    litePeopleRing,
    peopleRing,
    readScoreContext,
    type RingLocation,
    type ScoreContextChain,
} from "./rings.js";
import { sameAccount } from "./same-account.js";
import {
    chainNow,
    readGameSeat,
    type GameSeat,
    type SeatPath,
    type SeatRoute,
    type TimestampChain,
} from "./seat.js";
import {
    mintAccountAirdropVrfs,
    mintAliasAirdropVrfs,
    readGameSignUpRequirement,
    signUpWithAccountTx,
    type AirdropVrfSigner,
    type AliasAirdropVrfs,
    type AliasDrawProofContext,
    type FeeEstimable,
    type SignUpChain,
    type SignUpFundsChain,
} from "./signup.js";
import {
    readLiteSignUpRequirement,
    signUpWithLiteInviteTx,
    type LiteSignUpChain,
} from "./signup-lite.js";
import type {
    AccountVrfSignature,
    LiteSignUpBlocker,
    LiteSignUpRequirement,
} from "./signup-types.js";
import { airdropVrfTranscript, type VrfTranscript } from "./signup-vrf.js";

// ── what the module needs from the chain ─────────────────────────────────────

/** One event of a transaction watch, in the fields this module reads. */
export interface TxWatchEvent {
    type: string;
    ok?: boolean;
    dispatchError?: unknown;
}

/**
 * A transaction watch: PAPI's `Observable` of transaction events satisfies it,
 * and so does `tx`'s `SubmittableTransaction` watch. The observer's members are
 * methods so their parameters compare bivariantly, as `tx`'s own type relies on.
 */
export interface TxWatch {
    subscribe(observer: {
        next(event: TxWatchEvent): void;
        error(error: unknown): void;
        complete?(): void;
    }): { unsubscribe(): void };
}

/**
 * A built sign-up call. PAPI 3 transactions have both methods; the fee read
 * uses the first and the `submit` capability the second.
 */
export interface SignUpTransaction extends FeeEstimable {
    createSubmitAndWatch(signer: CommonSignerTxCreator): TxWatch;
}

/**
 * Where the unsigned bind goes out: PAPI's `PolkadotClient.submitAndWatch`. The
 * bind is finished bytes with nothing to sign, which `tx`'s `submitAndWatch`
 * does not take, so it is submitted here.
 */
export interface RawSubmitChain {
    raw: {
        individuality: {
            submitAndWatch(transaction: Uint8Array): TxWatch;
        };
    };
}

/** The parts both chains share, over the transaction type the sign-up calls return. */
type SeatBindParts<Tx> = GameChain &
    SignUpChain<Tx> &
    ScoreContextChain &
    LiteSignUpChain<Tx> &
    LiteAliasBindChain &
    RawSubmitChain;

/** What {@link bindGameSeat} reads and submits through. */
export type GameSeatBindChain = SeatBindParts<unknown>;

/**
 * What {@link registerForGame} reads and submits through. A PAPI client and the
 * typed API for the individuality chain, joined by `fromPapi`, satisfy it.
 */
export type GameRegistrationChain = SeatBindParts<SignUpTransaction> &
    SignUpFundsChain &
    AirdropChain &
    TimestampChain;

// ── what the module needs from a host ────────────────────────────────────────

/** The game account: `dim2.<tld>` at `GAME_ACCOUNT_INDEX`. */
export interface GameAccount {
    /** SS58. */
    address: string;
    /** The 32-byte sr25519 public key. */
    publicKey: Uint8Array;
}

/** Which personhood key a proof is made with. */
export type PersonhoodKey = "lite" | "full";

/** A personhood key, the ring it is a member of, and the product that holds it. */
export interface PersonhoodRing {
    key: PersonhoodKey;
    /** The personhood product, `peopl.<tld>`: the owner a host lists the key under. */
    owner: string;
    ring: RingLocation;
}

/** A ring-VRF proof context, as a host's `createRingVRFProof` takes it. */
export type PersonhoodProofContext =
    | { productId: string; suffix: { tag: "Index"; value: number } }
    | AliasDrawProofContext;

/**
 * The personhood product's keys, as a host exposes them. The personhood product
 * uses its own keys; any other product needs its `context` grant.
 */
export interface PersonhoodProver {
    /** Whether the host holds this person's key in that ring. */
    holds(ring: PersonhoodRing): Promise<boolean>;
    /** A proof over `message` in `context` with that key. Rejects when the host refuses. */
    prove(
        ring: PersonhoodRing,
        context: PersonhoodProofContext,
        message: Uint8Array,
    ): Promise<RingVRFProof>;
}

/** How a sign-up submission ended, as the `submit` capability reports it. */
export type SignUpSubmitResult =
    | { ok: true }
    | {
          ok: false;
          /** The chain's error name, or what stopped it before the chain. */
          code: string;
          /** The player declined to sign. Never retried. */
          refused?: boolean;
          /** The watch lost track of it: it may still land. Read the seat before trying again. */
          landingUnknown?: boolean;
      };

/** Options the flow hands the `submit` capability. */
export interface SignUpSubmitOptions {
    waitFor: "best-block" | "finalized";
    /** Called once the transaction is on the wire, for an optimistic UI. */
    onBroadcast?: () => void;
}

/** Signs and submits the built sign-up. The host adapter wraps `tx`'s `submitAndWatch`. */
export type SubmitSignUp = (
    tx: SignUpTransaction,
    signer: CommonSignerTxCreator,
    options: SignUpSubmitOptions,
) => Promise<SignUpSubmitResult>;

/**
 * Everything a host does for a sign-up. Build it from a host with
 * `hostGameRegistrationCapabilities` from `@parity/product-sdk-individuality/host`.
 */
export interface GameRegistrationCapabilities {
    account: GameAccount;
    /** The game account's signer: `getProductAccountSigner`. */
    signer: CommonSignerTxCreator;
    /** Submits the built sign-up. */
    submit: SubmitSignUp;
    /** An sr25519 VRF by the game account, for account-arm draw tickets. Without it, no tickets. */
    signVrf?: AirdropVrfSigner["signVrf"];
    /**
     * Checks a ticket before it rides the sign-up. One bad ticket fails the whole
     * sign-up, so a product that can verify should; this package has no
     * schnorrkel verifier of its own.
     */
    verifyVrf?: (
        publicKey: Uint8Array,
        transcript: VrfTranscript,
        signature: AccountVrfSignature,
    ) => boolean;
    /** The personhood keys. Without it, no free route and no member draw entries. */
    personhood?: PersonhoodProver;
}

// ── errors, the report, retries ──────────────────────────────────────────────

/** A step of {@link registerForGame}. */
export type GameRegistrationStep = "seat" | "bind" | "draws" | "sign";

/** Where {@link registerForGame} is, for a product's progress UI: a step, or the broadcast. */
export type GameRegistrationStage = GameRegistrationStep | "broadcast";

/** Why a sign-up went out without its draw entries. */
export type DrawSkipKind =
    /** A draw was not taking entries yet, and the wait ran out. */
    | "not-open"
    /** The game has left registration, or a draw has closed. */
    | "closed"
    /** Registration is about to close; the sign-up goes now. */
    | "closing"
    /** A read failed, and the wait ran out. */
    | "read-failed"
    /** No VRF signer, or the tickets were not signed or did not verify. Not retried. */
    | "signature"
    /** A recognized person, and the member key could not prove the draws. Not retried. */
    | "verified-person"
    /** The chain would refuse the entry for something about the player. */
    | "refused";

/** What a sign-up carried for the game's prize draws. */
export interface DrawOutcome {
    /** How many draws the sign-up enters. */
    entered: number;
    /** `Game.airdrops_scheduled`. */
    scheduled: number;
    /** Why none, when `entered` is 0 and draws were scheduled. */
    skipped?: string;
    kind?: DrawSkipKind;
    /** How long the sign-up waited for a draw to open. */
    waitedMs: number;
    retries: number;
}

/** Why a bind did not put the person's binding on the game account. */
export type GameSeatBindRefusal =
    /**
     * The person's free seat is pinned to another account (`Game.LiteInvites`).
     * Binding this one would strand that seat, so nothing is submitted.
     */
    | "pinned-elsewhere"
    /**
     * A bind cannot succeed here: the account is itself a lite person's
     * (`AccountIsALitePerson`), or carries a binding in another context
     * (`AliasBoundElsewhere`, which only an unbind in that context clears).
     * Refused before any proof is asked for.
     */
    | "dead-end"
    /** The chain's score context is not one a host can mint the proof in. */
    | "no-proof-context"
    /** No personhood prover, or the host holds no lite key for this person. */
    | "no-lite-key"
    /** The chain refused the submission. `code` is the chain's own error name. */
    | "rejected";

/** What {@link bindGameSeat} did. */
export type BindGameSeatOutcome = "bound" | "already-bound";

/**
 * What one {@link registerForGame} call did, for the product's telemetry: when
 * each step ran and how it ended. Carried by every outcome and every
 * {@link GameRegistrationError}, so a failure reports how far it got.
 */
export interface GameRegistrationReport {
    /** When each step started and ended, in wall-clock milliseconds. */
    steps: Partial<Record<GameRegistrationStep, { startedAt: number; endedAt?: number }>>;
    /** When the sign-up went on the wire. */
    broadcastAt?: number;
    seat?: { path: SeatPath; ready: boolean; registered: boolean; open: boolean };
    bind?:
        | { outcome: BindGameSeatOutcome }
        | { outcome: "refused"; refusal: GameSeatBindRefusal; code: string; permanent: boolean };
    route?: SeatRoute;
    draws?: DrawOutcome;
    signUp?: {
        outcome: "registered" | "already-registered" | "failed";
        code?: string;
        landingUnknown?: boolean;
    };
}

/**
 * A step of the registration that failed. `stage` says which, `code` what the
 * chain or the host answered, and `retryable` whether running the call again can
 * change the answer. Running it again is always safe: every step re-reads the
 * chain first.
 */
export class GameRegistrationError extends ProductIndividualityError {
    readonly stage: GameRegistrationStep;
    readonly code: string;
    /** False when trying again cannot help: a refusal, a closed registration, a bad call. */
    readonly retryable: boolean;
    /** The sign-up's watch lost track: it may still land. */
    readonly landingUnknown: boolean;
    /** What the call did up to the failure. Set by {@link registerForGame}. */
    report?: GameRegistrationReport;

    constructor(
        stage: GameRegistrationStep,
        code: string,
        options: {
            retryable: boolean;
            landingUnknown?: boolean;
            message?: string;
            cause?: unknown;
        },
    ) {
        super(
            options.message ?? `game registration failed at ${stage}: ${code}`,
            options.cause === undefined ? undefined : { cause: options.cause },
        );
        this.name = "GameRegistrationError";
        this.stage = stage;
        this.code = code;
        this.retryable = options.retryable;
        this.landingUnknown = options.landingUnknown === true;
    }
}

/**
 * The chain's refusals of `PeopleLite.set_alias_account` that trying again will
 * not change: the account already carries another person's binding, the proof's
 * context is not one the chain binds in, or the account is itself a lite person.
 * `CallBlockOutOfRange` and the pool's validity codes can pass next time, so
 * they are not here; `AliasAccountAlreadySet` means the binding is there.
 */
const PERMANENT_BIND_CODES: ReadonlySet<string> = new Set([
    "AccountInUse",
    "InvalidAliasContext",
    "AlreadyRegistered",
]);

function bindIsPermanent(refusal: GameSeatBindRefusal, code: string): boolean {
    return refusal !== "rejected" || PERMANENT_BIND_CODES.has(code);
}

/** A bind that did not land. `permanent` closes the lite route for this account. */
export class GameSeatBindError extends GameRegistrationError {
    /** True when trying again cannot change the answer. The opposite of `retryable`. */
    readonly permanent: boolean;

    constructor(
        readonly refusal: GameSeatBindRefusal,
        code: string,
        /** For `"pinned-elsewhere"`, the account the seat is pinned to. */
        readonly account?: string,
    ) {
        const permanent = bindIsPermanent(refusal, code);
        super("bind", code, {
            retryable: !permanent,
            message:
                refusal === "pinned-elsewhere"
                    ? `lite bind refused: the person's free seat is on ${account ?? "another account"}`
                    : `lite bind failed: ${code}`,
        });
        this.name = "GameSeatBindError";
        this.permanent = permanent;
    }
}

/**
 * The sign-up refusals that trying again will not change: no game or a closed
 * registration, a draw entry the chain will never take, a seat pinned to another
 * account, an account that cannot pay, a declined signature, or a call that
 * could not be built.
 */
const NOT_RETRYABLE_SIGN_UP: ReadonlySet<string> = new Set([
    "NoGame",
    "NoRegistration",
    "InvalidAirdropVrfCount",
    "InvalidAirdropVrfVariant",
    "InvalidAirdropVrfVariantForAccount",
    "InvalidAirdropVrfVariantForRecognition",
    "AnotherAccountInvited",
    "StatementAccountAlreadyInUse",
    "Payment",
    "InsufficientBalance",
    "SigningRejected",
    "InvalidSignUp",
]);

/**
 * How long to wait before running a failed registration again, after the
 * `failures`-th failure in a row (1-based): 5 s, 15 s, 45 s, 2 min, then 5 min
 * between tries. Ported from jollity-next's bind ladder. When to retry at all
 * is the product's call; check `retryable` first.
 */
export const GAME_REGISTRATION_RETRY_MS: readonly number[] = [
    5_000, 15_000, 45_000, 120_000, 300_000,
];

export function registrationRetryDelay(failures: number): number {
    const index =
        Math.min(Math.max(Math.floor(failures), 1), GAME_REGISTRATION_RETRY_MS.length) - 1;
    return GAME_REGISTRATION_RETRY_MS[index]!;
}

/**
 * The name of a chain error, wherever PAPI or `tx` nests it: the innermost
 * `type` of a dispatch or validity error, else the error's message.
 *
 * Internal: shared with the host adapter.
 */
export function errorName(error: unknown): string {
    let node: unknown = error;
    let name: string | undefined;
    while (node !== null && typeof node === "object") {
        const { type, value } = node as { type?: unknown; value?: unknown };
        if (typeof type === "string") name = type;
        node = value;
    }
    if (name) return name;
    if (error instanceof Error && error.message) return error.message;
    return typeof error === "string" && error ? error : "DispatchError";
}

function asRegistrationError(step: GameRegistrationStep, error: unknown): GameRegistrationError {
    if (error instanceof GameRegistrationError) return error;
    const aborted = error instanceof Error && error.name === "AbortError";
    return new GameRegistrationError(step, aborted ? "Aborted" : errorName(error), {
        retryable: true,
        cause: error,
    });
}

// ── personhood facts ─────────────────────────────────────────────────────────

/** The personhood rings on this chain, and whether a host can prove in them. */
interface PersonhoodFacts {
    /** `Score.score_context` is the product derivation a host mints in. */
    derived: boolean;
    /** `peopl.<tld>`. */
    owner: string;
    lite: PersonhoodRing;
    full: PersonhoodRing;
}

async function readPersonhoodFacts(
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
function liteProof(prover: PersonhoodProver, facts: PersonhoodFacts): CreateRingVRFProof {
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

/** PAPI's words when the block subscription under a watch ended before the transaction's fate was known. */
function isTrackingStopped(error: unknown): boolean {
    return error instanceof Error && /tracking stopped/i.test(error.message);
}

/**
 * Drive the raw bind's watch to the best block that holds it. An invalid
 * transaction arrives on the error channel and settles as a failure, never a
 * throw; a watch that completes with no block holding it settles as a failure
 * too. An abort before `broadcasted` rejects with the signal's reason; after it
 * the transaction may land, so the abort is ignored.
 */
function settleRaw(watch: TxWatch, signal?: AbortSignal): Promise<Settled> {
    return new Promise<Settled>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        let settled = false;
        let broadcast = false;
        // biome-ignore lint/style/useConst: PAPI can emit during `subscribe`, and `finish` reads `sub` then; a `const` would still be in its temporal dead zone.
        let sub: { unsubscribe(): void } | undefined;
        const finish = (done: () => void) => {
            if (settled) return;
            settled = true;
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
    submitRaw: (chain, transaction, signal) =>
        settleRaw(chain.raw.individuality.submitAndWatch(transaction), signal),
};

/**
 * Bind the person's lite alias to the game account: `PeopleLite.set_alias_account`,
 * unsigned, carrying a proof from the personhood product's lite key in
 * `Score.score_context`. Resolves once a best block holds it.
 *
 * Reads before it builds, because the binding is the only replay protection and
 * a retry after a timeout may follow a bind that landed:
 *
 * - **Already bound** in the score context, current or stale, resolves
 *   `already-bound` with nothing asked for. A stale binding is re-pointed by the
 *   sign-up's revised leg.
 * - **A bind that cannot succeed** (the account is a lite person's own, it is
 *   bound in another context, the seat is pinned elsewhere, or no host can mint
 *   the proof) is refused before any proof is requested.
 * - **Otherwise** it proves, checks the forever pin (`Game.LiteInvites[alias]`)
 *   on the alias the proof names, and submits. The requirement read reports
 *   that pin only once this account holds the binding, which is too late, so
 *   the check is here.
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

async function runBind(
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
    const result = await steps.submitRaw(chain, built.transaction, signal);
    if (result.ok) return "bound";
    if (result.error === "AliasAccountAlreadySet") return "already-bound";
    throw new GameSeatBindError("rejected", result.error);
}

// ── step 3: the draw entries ─────────────────────────────────────────────────

type DrawEntries =
    | { entries: AccountVrfSignature[] | AliasAirdropVrfs; scheduled: number }
    | {
          entries?: undefined;
          skipped: string;
          scheduled: number;
          /** The reason is of the moment: wait a block and ask again. */
          wait?: boolean;
          kind?: DrawSkipKind;
      };

/** What the draw decision reads from a sign-up requirement, of either route. */
type DrawRequirement = Pick<
    LiteSignUpRequirement,
    "variant" | "phase" | "registrationEnds" | "airdropsScheduled" | "eventIds"
> & {
    blockers: readonly { tag: string }[];
};

/**
 * The requirement's blockers that describe the game's moment rather than the
 * player. The draw decision reads the phase and every draw's status at the best
 * block itself, so only blockers about the player skip the draws.
 */
const MOMENT_BLOCKERS: ReadonlySet<string> = new Set([
    "NoGameRunning",
    "NotInRegistration",
    "RegistrationEnded",
    "NoDrawsScheduled",
]);

/** A stale binding is re-pointed inside the free sign-up, so it does not cost the draws. */
const FIXED_BY_THE_SIGN_UP: ReadonlySet<string> = new Set(["StaleAlias"]);

const entryCount = (entries: AccountVrfSignature[] | AliasAirdropVrfs) =>
    Array.isArray(entries) ? entries.length : entries.proofs.length;

/**
 * The draw entries a sign-up carries, decided from the requirement read at the
 * best block, the one the sign-up is validated against. There is no way to
 * enter a draw after signing up, and a count that disagrees with
 * `airdrops_scheduled` fails the whole sign-up, so every gate is checked here:
 * draws are scheduled, the game is in registration, nothing about the player
 * bars the entry, every draw is `Registering`, and the tickets (or a recognized
 * person's proofs) are minted. A draw that is not open yet says `wait`; a
 * signature or proof that is refused does not, so a player who declined is not
 * asked again.
 */
async function decideDraws(
    chain: AirdropChain,
    capabilities: GameRegistrationCapabilities,
    requirement: DrawRequirement,
    tld: string,
    facts: () => Promise<PersonhoodFacts>,
    signal: AbortSignal | undefined,
): Promise<DrawEntries> {
    const scheduled = requirement.airdropsScheduled;
    if (requirement.phase === null) return { skipped: "no game at the best block", scheduled: 0 };
    if (scheduled === 0) return { skipped: "the game has no prize draw", scheduled };
    if (requirement.phase !== "Registration") {
        return { skipped: `the game is in ${requirement.phase}`, scheduled, kind: "closed" };
    }
    if (requirement.variant === null || requirement.eventIds.length !== scheduled) {
        return {
            skipped: "the requirement does not describe the game's draws",
            scheduled,
            wait: true,
            kind: "read-failed",
        };
    }
    const recognized = requirement.variant === "Alias";
    if (recognized && !capabilities.personhood) {
        return {
            skipped: "a recognized person, and nothing here can prove the draw",
            scheduled,
            kind: "verified-person",
        };
    }
    if (!recognized && !capabilities.signVrf) {
        return { skipped: "no VRF signer", scheduled, kind: "signature" };
    }
    const blockers = requirement.blockers.filter((blocker) => !MOMENT_BLOCKERS.has(blocker.tag));
    if (blockers.length > 0) {
        return {
            skipped: `the chain would refuse the entry: ${blockers.map((b) => b.tag).join(", ")}`,
            scheduled,
            kind: "refused",
        };
    }

    const { eventIds } = requirement;
    try {
        const events = await Promise.all(
            eventIds.map((id) =>
                chain.individuality.query.Airdrop.Events.getValue(id, { at: "best", signal }),
            ),
        );
        for (const [index, event] of events.entries()) {
            // The offchain worker opens each draw a block after the game appears.
            const phase =
                event === undefined ? "Upcoming" : airdropPhase(statusTag(event.status.type));
            if (phase === "Upcoming") {
                return {
                    skipped: `draw #${index} is not taking entries yet`,
                    scheduled,
                    wait: true,
                    kind: "not-open",
                };
            }
            if (phase !== "Registering") {
                return {
                    skipped: `draw #${index} is ${phase}, not Registering`,
                    scheduled,
                    kind: "closed",
                };
            }
        }
    } catch (error) {
        return {
            skipped: `the draws could not be read: ${errorName(error)}`,
            scheduled,
            wait: true,
            kind: "read-failed",
        };
    }

    const registrant = { tag: "Account" as const, accountAddress: capabilities.account.address };
    if (recognized) {
        let personhood: PersonhoodFacts;
        try {
            personhood = await facts();
        } catch (error) {
            return {
                skipped: `no People key to prove the draws with: ${errorName(error)}`,
                scheduled,
                kind: "verified-person",
            };
        }
        const prover = capabilities.personhood!;
        const proved = await mintAliasAirdropVrfs(
            (context, message) => prover.prove(personhood.full, context, message),
            { eventIds, registrant, productId: gameProductId(tld), signal },
        );
        if (!proved.ok) {
            return {
                skipped: `the draws were not proved: ${errorName(proved.error)}`,
                scheduled,
                kind: "verified-person",
            };
        }
        return { entries: proved.value, scheduled };
    }

    const { publicKey } = capabilities.account;
    const minted = await mintAccountAirdropVrfs(
        { signVrf: capabilities.signVrf! },
        { eventIds, publicKey, signal },
    );
    if (!minted.ok) {
        return {
            skipped: `the tickets were not signed: ${errorName(minted.error)}`,
            scheduled,
            kind: "signature",
        };
    }
    if (capabilities.verifyVrf) {
        for (const [index, entry] of minted.value.entries()) {
            const transcript = airdropVrfTranscript({ eventId: eventIds[index]!, publicKey });
            if (!capabilities.verifyVrf(publicKey, transcript, entry)) {
                return {
                    skipped: `the ticket for draw #${index} does not verify against the game account`,
                    scheduled,
                    kind: "signature",
                };
            }
        }
    }
    return { entries: minted.value, scheduled };
}

/** How long a sign-up waits for draws that are not open yet. */
export interface DrawWaitOptions {
    /** The longest wait. Default 20 000 ms. */
    maxMs?: number;
    /** How often to ask again. Default 2 000 ms, about a block. */
    retryMs?: number;
    /**
     * Never wait into the last this-many seconds of registration, by the chain's
     * clock: a player who misses the game has lost more than one who misses a
     * ticket. Default 15.
     */
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

// ── the flow ─────────────────────────────────────────────────────────────────

/** Options for {@link registerForGame}. */
export interface RegisterForGameOptions {
    /** The network's DotNS TLD, such as `"paseo"`. */
    tld: string;
    /**
     * `CommunicationIdentifier`, exactly 65 bytes: the P-256 key co-players reach
     * this player with. Rewritten on every sign-up, so pass a key whose private
     * half the game product can use at game time.
     */
    identifierKey: Uint8Array;
    /** A seat read moments ago, to skip reading it again. Never pass a cached one on a retry. */
    seat?: GameSeat;
    /**
     * When the sign-up counts as done. Default `"best-block"`, as `tx`'s own: a
     * refusal arrives at the best block either way, and a sign-up a reorg drops is
     * caught by the next call, which reads the seat first. Pass `"finalized"` when
     * the answer must not be undone, at the cost of waiting for finality.
     */
    waitFor?: "best-block" | "finalized";
    drawWait?: DrawWaitOptions;
    /** Passed to {@link readGameSeat}. */
    feeHeadroom?: number;
    /** Stops the flow. Ignored once the sign-up is broadcast: it may still land. */
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
 * Sign the player up for the running game: seat, bind, draws, sign. See the
 * module doc.
 *
 * The ok channel carries every answer that is not a failure, including
 * `already-registered`, which is also what a race with another product ends in.
 * The err channel carries a {@link GameRegistrationError} (a
 * {@link GameSeatBindError} for the bind) with the failing step, the code,
 * whether a retry can help, and the report.
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
                const personhood = await facts();
                litePerson =
                    personhood.derived && (await capabilities.personhood.holds(personhood.lite));
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
        let retries = 0;
        let signer = capabilities.signer;
        let registrationEnds: number | null = null;

        const decide = async (): Promise<DrawEntries> => {
            const now = await steps.now(chain, signal);
            const requirement = await steps.requirement(chain, route, {
                account,
                tld,
                now,
                signal,
            });
            registrationEnds = requirement.registrationEnds;
            if (route === "free") {
                const stale = requirement.blockers.some((blocker) => blocker.tag === "StaleAlias");
                if (stale && !capabilities.personhood) {
                    throw new GameRegistrationError("draws", "StaleAliasNeedsLiteKey", {
                        retryable: false,
                        message:
                            "the binding is stale, and nothing here can make the proof that re-points it",
                    });
                }
                signer = withLiteAlias(
                    capabilities.signer,
                    stale
                        ? {
                              tag: "AliasWithAccountRevised",
                              createProof: liteProof(capabilities.personhood!, await facts()),
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

        let draws = await decide();
        while (draws.entries === undefined && draws.wait) {
            const isClosing = await closing();
            if (Date.now() - startedAt >= maxMs || isClosing) {
                draws = {
                    ...draws,
                    skipped: `${draws.skipped} (gave up waiting${isClosing ? ": registration is closing" : ""})`,
                    wait: false,
                    ...(isClosing ? { kind: "closing" as const } : {}),
                };
                break;
            }
            await sleep(retryMs, signal);
            retries += 1;
            draws = await decide();
        }
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
                cause: error,
            });
        }
        const result = await capabilities.submit(tx, signer, {
            waitFor: options.waitFor ?? "best-block",
            onBroadcast: () => {
                report.broadcastAt = Date.now();
                options.onStage?.("broadcast");
            },
        });
        end("sign");
        if (!result.ok) {
            // Another product may have signed the same account up a moment earlier.
            if (result.code === "AlreadyRegistered") {
                report.signUp = { outcome: "already-registered" };
                return { kind: "already-registered", report };
            }
            report.signUp = {
                outcome: "failed",
                code: result.code,
                ...(result.landingUnknown ? { landingUnknown: true } : {}),
            };
            throw new GameRegistrationError("sign", result.code, {
                retryable: result.refused !== true && !NOT_RETRYABLE_SIGN_UP.has(result.code),
                landingUnknown: result.landingUnknown,
            });
        }
        report.signUp = { outcome: "registered" };
        return { kind: "registered", route, draws: outcome, report };
    }
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { unwrapErr } = await import("@parity/result");
    const { AccountId } = await import("polkadot-api");

    const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    const IDENTIFIER = new Uint8Array(65).fill(0x22);
    const PUBLIC_KEY = AccountId().enc(ADDRESS);
    const RING = { chainId: "0x01" as const, junctions: [] };
    const FACTS: PersonhoodFacts = {
        derived: true,
        owner: "peopl.paseo",
        lite: { key: "lite", owner: "peopl.paseo", ring: RING },
        full: { key: "full", owner: "peopl.paseo", ring: RING },
    };
    const EVENT_IDS = [`0x${"11".repeat(32)}`, `0x${"12".repeat(32)}`];
    const TICKET = { preOutput: new Uint8Array(32).fill(3), proof: new Uint8Array(64).fill(4) };

    const baseSigner = { publicKey: PUBLIC_KEY } as unknown as CommonSignerTxCreator;
    const tagged = (...tags: string[]) => tags.map((tag) => ({ tag }) as LiteSignUpBlocker);

    const drawRequirement = (overrides: Partial<DrawRequirement> = {}): DrawRequirement => ({
        variant: "Account",
        phase: "Registration",
        registrationEnds: 2_000,
        airdropsScheduled: 2,
        eventIds: EVENT_IDS,
        blockers: [],
        ...overrides,
    });

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

    /** A `submit` capability that records what it was handed and answers `result`. */
    const fakeSubmit = (result: SignUpSubmitResult = { ok: true }) => {
        const calls: {
            call: string;
            signer: CommonSignerTxCreator;
            options: SignUpSubmitOptions;
        }[] = [];
        const submit: SubmitSignUp = async (tx, signer, options) => {
            calls.push({ call: (tx as unknown as { call: string }).call, signer, options });
            options.onBroadcast?.();
            return result;
        };
        return { submit, calls };
    };

    const capabilities = (
        extra: Partial<GameRegistrationCapabilities> = {},
    ): GameRegistrationCapabilities => ({
        account: { address: ADDRESS, publicKey: PUBLIC_KEY },
        signer: baseSigner,
        submit: fakeSubmit().submit,
        ...extra,
    });

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

    describe("decideDraws", () => {
        const eventsChain = (statuses: (string | undefined)[]) =>
            ({
                individuality: {
                    query: {
                        Airdrop: {
                            Events: {
                                getValue: async (id: string) => {
                                    const status = statuses[EVENT_IDS.indexOf(id)];
                                    return status === undefined
                                        ? undefined
                                        : { status: { type: status } };
                                },
                            },
                        },
                    },
                },
            }) as unknown as AirdropChain;
        const decide = (
            chain: AirdropChain,
            caps: GameRegistrationCapabilities,
            requirement: DrawRequirement = drawRequirement(),
        ) => decideDraws(chain, caps, requirement, "paseo", async () => FACTS, undefined);
        const signVrf = () => vi.fn(async () => TICKET);
        const open = () => eventsChain(["Registering", "Registering"]);

        test("enters every scheduled draw, one ticket per draw, in airdrop-index order", async () => {
            const sign = signVrf();
            const draws = await decide(open(), capabilities({ signVrf: sign }));
            expect(draws.entries).toHaveLength(2);
            expect(sign).toHaveBeenCalledTimes(2);
        });

        test("skips without a VRF signer, signing nothing", async () => {
            const draws = await decide(open(), capabilities());
            expect(draws).toMatchObject({ kind: "signature" });
            expect(draws.entries).toBeUndefined();
        });

        test("skips a game with no draw scheduled, signing nothing", async () => {
            const sign = signVrf();
            const draws = await decide(
                eventsChain([]),
                capabilities({ signVrf: sign }),
                drawRequirement({ airdropsScheduled: 0, eventIds: [] }),
            );
            expect(draws).toMatchObject({ skipped: "the game has no prize draw" });
            expect(sign).not.toHaveBeenCalled();
        });

        test("waits for a draw that is not on chain yet, or still scheduled", async () => {
            const caps = capabilities({ signVrf: signVrf() });
            expect(await decide(eventsChain([undefined, "Registering"]), caps)).toMatchObject({
                wait: true,
                kind: "not-open",
            });
            expect(await decide(eventsChain(["Scheduled", "Registering"]), caps)).toMatchObject({
                wait: true,
                kind: "not-open",
            });
        });

        test("skips a draw that has closed, without waiting", async () => {
            const draws = await decide(
                eventsChain(["Registering", "Claiming"]),
                capabilities({ signVrf: signVrf() }),
            );
            expect(draws).toMatchObject({ kind: "closed" });
            expect("wait" in draws && draws.wait).toBeFalsy();
        });

        test("enters even when the requirement says registration ended: the phase and the draws decide", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf() }),
                drawRequirement({ blockers: tagged("RegistrationEnded") }),
            );
            expect(draws.entries).toHaveLength(2);
        });

        test("skips on a blocker about the player", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf() }),
                drawRequirement({ blockers: tagged("NotSr25519") }),
            );
            expect(draws).toMatchObject({ kind: "refused" });
        });

        test("a refused ticket skips the draws without waiting, so nobody is asked again", async () => {
            const sign = vi.fn(async () => {
                throw new Error("user refused");
            });
            const draws = await decide(open(), capabilities({ signVrf: sign }));
            expect(draws).toMatchObject({ kind: "signature" });
            expect("wait" in draws && draws.wait).toBeFalsy();
            expect(sign).toHaveBeenCalledOnce();
        });

        test("a ticket that does not verify enters nothing", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf(), verifyVrf: () => false }),
            );
            expect(draws).toMatchObject({ kind: "signature" });
        });

        test("a recognized person with nothing to prove the draws skips them", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf() }),
                drawRequirement({ variant: "Alias" }),
            );
            expect(draws).toMatchObject({ kind: "verified-person" });
        });

        test("a refused member proof skips the draws without waiting", async () => {
            const prove = vi.fn(async () => {
                throw new Error("no grant for the People key");
            });
            const draws = await decide(
                open(),
                capabilities({ personhood: { holds: async () => true, prove } }),
                drawRequirement({ variant: "Alias" }),
            );
            expect(draws).toMatchObject({ kind: "verified-person" });
            expect("wait" in draws && draws.wait).toBeFalsy();
        });
    });

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
            expect(submitRaw).toHaveBeenCalledWith(expect.anything(), BUILT.transaction, undefined);
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
    });

    describe("registrationRetryDelay", () => {
        test("climbs the ladder and stays on its last rung", () => {
            expect([1, 2, 3, 4, 5, 9].map(registrationRetryDelay)).toEqual([
                5_000, 15_000, 45_000, 120_000, 300_000, 300_000,
            ]);
            expect(registrationRetryDelay(0)).toBe(5_000);
        });
    });

    describe("errorName", () => {
        test("finds the innermost name of a nested dispatch error", () => {
            expect(
                errorName({
                    type: "Module",
                    value: { type: "Game", value: { type: "NoRegistration" } },
                }),
            ).toBe("NoRegistration");
            expect(errorName(new Error("socket closed"))).toBe("socket closed");
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
