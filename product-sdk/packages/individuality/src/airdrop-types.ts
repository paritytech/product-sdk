// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * One draw is one `Airdrop` event, addressed by a derived id (`airdrop-ids.ts`).
 * `Game` and `PeopleAirdrops` schedule through the same mechanism, so everything
 * here is keyed by event id and knows nothing about which one did.
 */
import type { FinalizedSnapshot } from "./types.js";

/**
 * The chain's own `Status`, kept alongside {@link AirdropPhase} because the
 * collapse is lossy: a product renders one spinner for `AwaitingEntropy` and
 * `DrawWinners`, but someone debugging a stalled draw needs to know which.
 */
export type AirdropStatusTag =
    | "Scheduled"
    | "Registering"
    | "AwaitingEntropy"
    | "DrawWinners"
    | "Claiming"
    | "ClearingRegistrations"
    | "ClearingWinners"
    | "Finalizing";

/**
 * The phase a product renders. `Gone` is not a chain status but the row's absence
 * — the steady state for every past draw. It is **not** proof a draw happened: an id
 * that was never scheduled answers identically, and the chain cannot tell them
 * apart.
 */
export type AirdropPhase =
    /** `Scheduled` — announced, registration not open yet. */
    | "Upcoming"
    /** `Registering` — entries are being taken until `drawTime`. */
    | "Registering"
    /** `AwaitingEntropy` or `DrawWinners` — closed, winners not final yet. */
    | "Drawing"
    /** `Claiming` — winners are settled and claims are open until `endTime`. */
    | "Claiming"
    /** Any of the three clean-up states: over, with nothing left to do. */
    | "Settling"
    /** No `Events` row at all — finalized and cleaned up, or never scheduled. */
    | "Gone";

/**
 * The prize asset, as an XCM location. Opaque on purpose — this package does not
 * model XCM; it is the key an `Assets.Metadata` read takes.
 */
export interface AirdropAssetId {
    parents: number;
    interior: unknown;
}

/** The prize a draw pays out, from `AirdropPrize` on chain. */
export interface AirdropPrize {
    /**
     * **Not the chain's native token.** Prizes are paid in a foreign asset, so
     * formatting `assetAmount` with the chain's `tokenDecimals` is wrong. Read
     * `Assets.Metadata` for this id and use its `decimals`.
     */
    assetId: AirdropAssetId;
    /** Total amount paid across all winners, in the prize asset's smallest unit. */
    assetAmount: bigint;
    /** Hard cap on winners, whatever the participant count. */
    maxWinners: number;
    /**
     * The share of participants that may win, as a **Permill** — parts per
     * million, not a count and not a percentage. `10_000` is one percent.
     * Named for the unit because rendering it as a count is the mistake the
     * plain chain name (`winner_cap`) invites.
     */
    winnerCapPermill: number;
}

/**
 * The counters are `null` where the `Status` variant does not carry them — **not
 * zero**: a `Finalizing` draw did have participants, the chain stopped reporting it.
 *
 * | Field | Absent in |
 * |---|---|
 * | `totalParticipants` | `Scheduled`, `Finalizing` |
 * | `effectiveWinners` | `Scheduled`, `Registering` |
 * | `claimed` | `Scheduled`, `Registering`, `AwaitingEntropy`, `DrawWinners` |
 */
export interface AirdropEvent {
    /** The 32-byte event id, `0x`-prefixed, as the draw is addressed by. */
    eventId: string;
    status: AirdropStatusTag;
    phase: AirdropPhase;
    prize: AirdropPrize;
    /**
     * Unix timestamp in **seconds**, when registration opens.
     *
     * All three timestamps are `u64` seconds on chain, not block numbers and
     * not milliseconds. Multiply by 1000 before handing one to `Date`.
     */
    registrationStarts: number;
    /** Unix seconds: registration closes and the draw is performed. */
    drawTime: number;
    /** Unix seconds: claiming closes and clean-up starts. */
    endTime: number;
    totalParticipants: number | null;
    effectiveWinners: number | null;
    claimed: number | null;
    /**
     * The account funding this event, for source-funded draws. `null` for
     * pre-funded ones, whose released funds stay in the pallet's pot.
     */
    source: string | null;
}

/**
 * Which identity entered a draw. Not the player's choice on the game path: the
 * chain picks `Alias` for a recognized person and `Account` for everyone else.
 */
export type AirdropRegistrant =
    /** An SS58 account address. */
    | { tag: "Account"; accountAddress: string }
    /** A 32-byte contextual People alias, `0x`-prefixed. */
    | { tag: "Alias"; alias: string };

/**
 * Whether a registrant won. `Unchecked` exists so "we did not ask" cannot be
 * mistaken for "did not win" — a `false` there would be a claim the read never
 * made.
 */
export type AirdropOutcome =
    /** No registrant was supplied, so no winner lookup happened. */
    | { tag: "Unchecked" }
    /**
     * No winning entry. Before the draw that means "not drawn yet" and after it
     * "did not win" — the same storage answer, so read {@link AirdropEvent.phase}
     * to tell them apart.
     */
    | { tag: "NotWon" }
    /** Won. `ticket` is the 32-byte entropy slot the win is recorded under. */
    | { tag: "Won"; ticket: string };

/**
 * One draw at one pinned block. `event` is `null` exactly when `phase` is `"Gone"`,
 * but the outcome survives that: `Winners` is cleared in its own lifecycle state,
 * so a win can outlive the event row or be swept before it.
 */
export interface AirdropDraw {
    /** The finalized block every read in this row was pinned to. */
    at: FinalizedSnapshot;
    eventId: string;
    phase: AirdropPhase;
    event: AirdropEvent | null;
    outcome: AirdropOutcome;
    /**
     * The draw's entropy seed, present from `DrawWinners` onwards and `null`
     * before it. Only useful for verifying a draw independently; a product
     * rendering a result does not need it.
     */
    entropy: string | null;
}
