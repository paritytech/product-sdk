// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The saved-state envelope: what a provider's session stores with the host
 * through `fundingProvider.save`, and reads back from `Assigned.saved` after a
 * restart.
 *
 * The envelope is UTF-8 JSON, `{ f, v, s, j }`:
 * - `f`, the envelope's own format, so it can change without touching providers;
 * - `v`, the provider's state version from its {@link SavedStateSpec};
 * - `s`, the provider's state;
 * - `j`, the journal of top-ups, payment requests and actions the session
 *   started, which the library keeps so a restart finds them again.
 *
 * Bigints are kept as `{ "$big": "<decimal>" }`, so providers store them as they are.
 *
 * @module
 */
import type { FundingAssignment, HexString } from "@parity/truapi";

import { fromHex, toHex } from "../truapi.js";
import { StateTooLargeError } from "./errors.js";

/** Bytes the host keeps for one session's saved state. */
export const MAX_SAVED_BYTES = 4096;

/** The envelope format this build writes and reads. */
const ENVELOPE_FORMAT = 1;

/** How a provider's saved state is versioned, created and migrated. */
export interface SavedStateSpec<S> {
    /** The provider's own format number. Bump it on an incompatible change. */
    version: number;
    /** State for a session that saved nothing this provider can read. */
    initial(assignment: FundingAssignment): S;
    /**
     * Read the state an earlier `version` saved, or return `undefined` to
     * start the session over from {@link initial}.
     */
    migrate?(state: unknown, fromVersion: number): S | undefined;
}

/** One top-up, payment request or action the session started, by step. */
export interface JournalEntry {
    kind: "topUp" | "request" | "action";
    /** The id it was started under. */
    id: HexString;
    /** The amount of a top-up or payment request. */
    amount?: bigint;
    /** Unix ms when it was first started. */
    at: number;
    /** Whether an action finished. */
    done?: boolean;
    /** What a finished action returned. */
    result?: unknown;
}

/** The library's journal: what the session started, by step. */
export type Journal = Record<string, JournalEntry>;

/** What a session reads back from its assignment. */
export interface RestoredState<S> {
    state: S;
    journal: Journal;
    /** Whether the host handed back state this provider could read. */
    resumed: boolean;
}

interface Envelope {
    f: number;
    v: number;
    s: unknown;
    j: Journal;
}

function replacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? { $big: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
    if (
        value !== null &&
        typeof value === "object" &&
        Object.keys(value).length === 1 &&
        typeof (value as { $big?: unknown }).$big === "string"
    ) {
        return BigInt((value as { $big: string }).$big);
    }
    return value;
}

/** JSON with bigints, as hex bytes, for the host's storage and the screen channel. */
export function encodeJson(value: unknown): HexString {
    return toHex(new TextEncoder().encode(JSON.stringify(value, replacer)));
}

/** The inverse of {@link encodeJson}. Throws on bytes that are not such JSON. */
export function decodeJson(hex: HexString): unknown {
    return JSON.parse(new TextDecoder().decode(fromHex(hex)), reviver);
}

/**
 * Encode the state and journal into the bytes `save` stores. Throws
 * {@link StateTooLargeError} past {@link MAX_SAVED_BYTES}, before the host is asked.
 */
export function encodeEnvelope<S>(spec: SavedStateSpec<S>, state: S, journal: Journal): HexString {
    const envelope: Envelope = { f: ENVELOPE_FORMAT, v: spec.version, s: state, j: journal };
    const hex = encodeJson(envelope);
    const size = (hex.length - 2) / 2;
    if (size > MAX_SAVED_BYTES) throw new StateTooLargeError(size, MAX_SAVED_BYTES);
    return hex;
}

/**
 * Read the state and journal an assignment hands back. Anything this build
 * cannot read starts the session over from `spec.initial`, without losing the
 * journal when only the provider's state is unreadable: the journal is what
 * keeps a restarted session from moving funds twice.
 */
export function decodeEnvelope<S>(
    assignment: FundingAssignment,
    spec: SavedStateSpec<S>,
): RestoredState<S> {
    const fresh = (journal: Journal = {}): RestoredState<S> => ({
        state: spec.initial(assignment),
        journal,
        resumed: false,
    });
    if (assignment.saved === undefined) return fresh();
    let envelope: Envelope;
    try {
        envelope = decodeJson(assignment.saved) as Envelope;
    } catch {
        return fresh();
    }
    if (envelope === null || typeof envelope !== "object" || envelope.f !== ENVELOPE_FORMAT) {
        return fresh();
    }
    const journal = envelope.j && typeof envelope.j === "object" ? envelope.j : {};
    if (envelope.v === spec.version) {
        return { state: envelope.s as S, journal, resumed: true };
    }
    const migrated = spec.migrate?.(envelope.s, envelope.v);
    return migrated === undefined ? fresh(journal) : { state: migrated, journal, resumed: true };
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    interface V2 {
        phase: string;
        order?: string;
        amount: bigint;
    }
    const spec: SavedStateSpec<V2> = {
        version: 2,
        initial: () => ({ phase: "new", amount: 0n }),
        migrate: (state, from) =>
            from === 1 ? { ...(state as { phase: string }), amount: 0n } : undefined,
    };
    const assignment = (saved?: HexString): FundingAssignment => ({
        intent: "i",
        direction: "In",
        saved,
    });

    describe("saved-state envelope", () => {
        test("round-trips state, journal and bigints", () => {
            const journal: Journal = {
                "topup/0": { kind: "topUp", id: "0x01", amount: 5n, at: 1 },
            };
            const saved = encodeEnvelope(spec, { phase: "paid", amount: 10n }, journal);
            expect(decodeEnvelope(assignment(saved), spec)).toEqual({
                state: { phase: "paid", amount: 10n },
                journal,
                resumed: true,
            });
        });

        test("nothing saved starts from initial", () => {
            expect(decodeEnvelope(assignment(), spec)).toEqual({
                state: { phase: "new", amount: 0n },
                journal: {},
                resumed: false,
            });
        });

        test("an earlier version is migrated", () => {
            const v1 = encodeEnvelope({ version: 1, initial: () => ({}) }, { phase: "paid" }, {});
            const restored = decodeEnvelope(assignment(v1), spec);
            expect(restored.state).toEqual({ phase: "paid", amount: 0n });
            expect(restored.resumed).toBe(true);
        });

        test("a version migrate refuses starts over but keeps the journal", () => {
            const journal: Journal = {
                payment: { kind: "request", id: "0x02", amount: 1n, at: 1 },
            };
            const v9 = encodeEnvelope({ version: 9, initial: () => ({}) }, { x: 1 }, journal);
            expect(decodeEnvelope(assignment(v9), spec)).toEqual({
                state: { phase: "new", amount: 0n },
                journal,
                resumed: false,
            });
        });

        test("bytes that are not an envelope start over", () => {
            expect(decodeEnvelope(assignment("0xdeadbeef"), spec).resumed).toBe(false);
            expect(decodeEnvelope(assignment(encodeJson({ f: 7 })), spec).resumed).toBe(false);
        });

        test("state over the host's limit is refused before saving", () => {
            expect(() =>
                encodeEnvelope(spec, { phase: "x".repeat(MAX_SAVED_BYTES), amount: 0n }, {}),
            ).toThrow(StateTooLargeError);
        });
    });
}
