// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The types game registration shares across its modules: what it needs from
 * the chain and from a host, and what it reports.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";

import type { AirdropChain } from "./airdrop-read.js";
import type { LiteAliasBindChain } from "./bind-lite-alias.js";
import type { GameChain } from "./game-read.js";
import type { RingVRFProof } from "./origin-extension.js";
import type { RingLocation, ScoreContextChain } from "./rings.js";
import type { SeatPath, SeatRoute, TimestampChain } from "./seat.js";
import type {
    AirdropVrfSigner,
    AliasDrawProofContext,
    FeeEstimable,
    SignUpChain,
    SignUpFundsChain,
} from "./signup.js";
import type { LiteSignUpChain } from "./signup-lite.js";
import type { AccountVrfSignature } from "./signup-types.js";
import type { VrfTranscript } from "./signup-vrf.js";

// ── what the module needs from the chain ─────────────────────────────────────

/** One event of a transaction watch, in the fields this module reads. */
export interface TxWatchEvent {
    type: string;
    ok?: boolean;
    dispatchError?: unknown;
}

/**
 * A transaction watch, as PAPI and `tx` both give one. The observer's members are
 * methods so they compare bivariantly, as `tx`'s type needs.
 */
export interface TxWatch {
    subscribe(observer: {
        next(event: TxWatchEvent): void;
        error(error: unknown): void;
        complete?(): void;
    }): { unsubscribe(): void };
}

/** A built sign-up call, as PAPI 3 returns it: fee-estimable and submittable. */
export interface SignUpTransaction extends FeeEstimable {
    createSubmitAndWatch(signer: CommonSignerTxCreator): TxWatch;
}

/** Where the bind's finished, unsigned bytes go out: PAPI's `submitAndWatch`. */
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

/** What {@link registerForGame} reads and submits through; `fromPapi` gives one. */
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

/** The personhood product's keys, as a host exposes them; other products need its `context` grant. */
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
    /** The caller's abort. The flow already drops a late signature; a `submit` that can stop sooner should. */
    signal?: AbortSignal;
}

/** Signs and submits the built sign-up. The host adapter wraps `tx`'s `submitAndWatch`. */
export type SubmitSignUp = (
    tx: SignUpTransaction,
    signer: CommonSignerTxCreator,
    options: SignUpSubmitOptions,
) => Promise<SignUpSubmitResult>;

/** Everything a host does for a sign-up; `hostGameRegistrationCapabilities` builds it. */
export interface GameRegistrationCapabilities {
    account: GameAccount;
    /** The game account's signer: `getProductAccountSigner`. */
    signer: CommonSignerTxCreator;
    /** Submits the built sign-up. */
    submit: SubmitSignUp;
    /** An sr25519 VRF by the game account, for account-arm draw tickets. Without it, no tickets. */
    signVrf?: AirdropVrfSigner["signVrf"];
    /** Checks a ticket before it rides the sign-up, where one bad ticket fails it all. */
    verifyVrf?: (
        publicKey: Uint8Array,
        transcript: VrfTranscript,
        signature: AccountVrfSignature,
    ) => boolean;
    /** The personhood keys. Without it, no free route and no member draw entries. */
    personhood?: PersonhoodProver;
}

// ── steps, draws and the report ──────────────────────────────────────────────

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
    /** The person's free seat is pinned to another account (`Game.LiteInvites`). */
    | "pinned-elsewhere"
    /** The bind cannot succeed: `AccountIsALitePerson` or `AliasBoundElsewhere`. */
    | "dead-end"
    /** The chain's score context is not one a host can mint the proof in. */
    | "no-proof-context"
    /** No personhood prover, or the host holds no lite key for this person. */
    | "no-lite-key"
    /** The chain refused the submission. `code` is the chain's own error name. */
    | "rejected";

/** What {@link bindGameSeat} did. */
export type BindGameSeatOutcome = "bound" | "already-bound";

/** What one {@link registerForGame} call did, for telemetry; failures carry it too. */
export interface GameRegistrationReport {
    /** When each step started and ended, in wall-clock milliseconds. */
    steps: Partial<Record<GameRegistrationStep, { startedAt: number; endedAt?: number }>>;
    /** When the sign-up went on the wire. */
    broadcastAt?: number;
    seat?: { path: SeatPath; ready: boolean; registered: boolean; open: boolean };
    /** Why the host's lite key could not be looked up; the free route was closed. */
    liteKeyLookupFailed?: string;
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
