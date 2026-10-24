// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { bytesEqual } from "../bytes.js";
import { nextExpiry } from "../crypto/derivations.js";
import { PROTOCOL_ACK_CODE } from "../wire/statementData.js";

/** Bytes a statement adds around its request messages (`CommunicationState.kt`). */
export const REQUEST_OVERHEAD = 32 + 32 + 8 + 64 + 32;

/** Largest contact-session statement: 100 KiB (Android). */
export const CONTACT_MAX_STATEMENT_BYTES = 100 * 1024;

/** An outgoing request: messages under one id and expiry. */
export interface OutgoingRequest {
    requestId: string;
    expiry: bigint;
    messages: Uint8Array[];
}

/** An incoming request, with the expiry of its statement. */
export interface IncomingRequest {
    requestId: string;
    expiry: bigint;
    messages: Uint8Array[];
}

/** An acknowledgement to send or that arrived. */
export interface ResponseRecord {
    requestId: string;
    expiry: bigint;
    responseCode: number;
}

/** One compacted batch: the commit message that replaced the originals. */
export interface CompactedBatch {
    commit: Uint8Array;
    originals: Uint8Array[];
}

/** Session state (Appendix A.8). */
export type SessionState =
    | { kind: "Initialization"; pending: Uint8Array[] }
    | {
          kind: "Active";
          outgoing: OutgoingRequest | undefined;
          seenIncoming: Set<string>;
          pending: Uint8Array[];
          expiry: bigint;
          isCompacting: boolean;
      };

/** What the session learned from its stored statements on (re)start. */
export interface InitialData {
    outgoingPending: OutgoingRequest | undefined;
    incoming: { request: IncomingRequest; responded: boolean }[];
    lastUsedExpiry: bigint;
}

/** Inputs of the state machine. */
export type SessionEvent =
    | { kind: "SubmitMessage"; message: Uint8Array }
    | { kind: "InitialDataFetched"; data: InitialData }
    | { kind: "RequestReceived"; request: IncomingRequest }
    | { kind: "ResponseReceived"; response: ResponseRecord }
    | { kind: "CompactionCompleted"; batches: CompactedBatch[] }
    | { kind: "CompactionFailed" }
    | { kind: "InvalidateSession" };

/** Outputs of the state machine, executed in order by the session runtime. */
export type SessionEffect =
    | { kind: "FetchInitialData" }
    | { kind: "StartPolling" }
    | { kind: "StopPolling" }
    | { kind: "SubmitRequest"; request: OutgoingRequest }
    | { kind: "SubmitResponse"; response: ResponseRecord }
    | { kind: "RequestReceived"; request: IncomingRequest }
    | { kind: "ResponseReceived"; messages: Uint8Array[] }
    | { kind: "Compact"; messages: Uint8Array[] }
    | { kind: "MessagesCompacted"; batch: CompactedBatch }
    | { kind: "MessageTooLarge"; message: Uint8Array };

/** Fixed parameters and sources of a session. */
export interface SessionContext {
    maxStatementBytes: number;
    canCompact: boolean;
    nowMs(): number;
    newRequestId(): string;
}

/** The initial state and its first effect. */
export function initialSession(): { state: SessionState; effects: SessionEffect[] } {
    return {
        state: { kind: "Initialization", pending: [] },
        effects: [{ kind: "FetchInitialData" }],
    };
}

interface Split {
    fits: Uint8Array[];
    remaining: Uint8Array[];
}

function maxRequestBytes(context: SessionContext): number {
    return context.maxStatementBytes - REQUEST_OVERHEAD;
}

function split(messages: Uint8Array[], context: SessionContext): Split {
    const limit = maxRequestBytes(context);
    let total = 0;
    let index = 0;
    for (; index < messages.length; index++) {
        const size = messages[index]?.length ?? 0;
        if (total + size > limit) break;
        total += size;
    }
    return { fits: messages.slice(0, index), remaining: messages.slice(index) };
}

function oversized(message: Uint8Array, context: SessionContext): boolean {
    return message.length > maxRequestBytes(context);
}

function containsBytes(list: Uint8Array[], message: Uint8Array): boolean {
    return list.some((candidate) => bytesEqual(candidate, message));
}

function without(list: Uint8Array[], removed: Uint8Array[]): Uint8Array[] {
    return list.filter((candidate) => !containsBytes(removed, candidate));
}

type Active = Extract<SessionState, { kind: "Active" }>;
/** One transition: the next state and the effects to run, in order. */
export type Step = { state: SessionState; effects: SessionEffect[] };

function submitSplit(
    state: Active,
    chunks: Split,
    context: SessionContext,
    continueCompacting?: Uint8Array[],
): Step {
    const expiry = nextExpiry(state.expiry, context.nowMs());
    const request: OutgoingRequest = {
        requestId: context.newRequestId(),
        expiry,
        messages: chunks.fits,
    };
    const effects: SessionEffect[] = [{ kind: "SubmitRequest", request }];
    if (continueCompacting) effects.push({ kind: "Compact", messages: continueCompacting });
    return {
        state: {
            ...state,
            outgoing: request,
            expiry,
            pending: chunks.remaining,
            isCompacting: continueCompacting !== undefined,
        },
        effects,
    };
}

function startCompaction(
    state: Active,
    toCompact: Uint8Array[],
    pending: Uint8Array[],
    outgoing: OutgoingRequest | undefined,
): Step {
    return {
        state: { ...state, outgoing, pending, isCompacting: true },
        effects: [{ kind: "Compact", messages: toCompact }],
    };
}

/**
 * The session state machine of the native apps (`Initialization.kt`, `Active.kt`):
 * one request in flight, new messages supersede it under a new request id,
 * every incoming request acknowledged at once, no retransmission timers.
 */
export function transition(
    state: SessionState,
    event: SessionEvent,
    context: SessionContext,
): Step {
    return state.kind === "Initialization"
        ? initializationTransition(state, event, context)
        : activeTransition(state, event, context);
}

function initializationTransition(
    state: Extract<SessionState, { kind: "Initialization" }>,
    event: SessionEvent,
    context: SessionContext,
): Step {
    switch (event.kind) {
        case "SubmitMessage": {
            if (oversized(event.message, context) && !context.canCompact) {
                return { state, effects: [{ kind: "MessageTooLarge", message: event.message }] };
            }
            if (containsBytes(state.pending, event.message)) return { state, effects: [] };
            return { state: { ...state, pending: [...state.pending, event.message] }, effects: [] };
        }
        case "InitialDataFetched": {
            const effects: SessionEffect[] = [];
            let expiry = event.data.lastUsedExpiry;
            const seenIncoming = new Set<string>();
            for (const { request, responded } of event.data.incoming) {
                if (!responded) {
                    expiry = nextExpiry(expiry, context.nowMs());
                    effects.push({ kind: "RequestReceived", request });
                    effects.push({
                        kind: "SubmitResponse",
                        response: {
                            requestId: request.requestId,
                            expiry,
                            responseCode: PROTOCOL_ACK_CODE,
                        },
                    });
                }
                seenIncoming.add(request.requestId);
            }
            const outgoing = event.data.outgoingPending;
            const active: Active = {
                kind: "Active",
                outgoing,
                seenIncoming,
                pending: [],
                expiry,
                isCompacting: false,
            };
            if (state.pending.length === 0) {
                return { state: active, effects: [...effects, { kind: "StartPolling" }] };
            }
            const combined = [...(outgoing?.messages ?? []), ...state.pending];
            const chunks = split(combined, context);
            if (context.canCompact && chunks.remaining.length > 0) {
                return {
                    state: { ...active, pending: state.pending, isCompacting: true },
                    effects: [
                        ...effects,
                        { kind: "Compact", messages: combined },
                        { kind: "StartPolling" },
                    ],
                };
            }
            if (chunks.fits.length > (outgoing?.messages.length ?? 0)) {
                const step = submitSplit(active, chunks, context);
                return {
                    state: step.state,
                    effects: [...effects, ...step.effects, { kind: "StartPolling" }],
                };
            }
            return {
                state: { ...active, pending: state.pending },
                effects: [...effects, { kind: "StartPolling" }],
            };
        }
        default:
            return { state, effects: [] };
    }
}

function activeTransition(state: Active, event: SessionEvent, context: SessionContext): Step {
    switch (event.kind) {
        case "SubmitMessage": {
            const message = event.message;
            if (oversized(message, context) && !context.canCompact) {
                return { state, effects: [{ kind: "MessageTooLarge", message }] };
            }
            if (
                containsBytes(state.pending, message) ||
                containsBytes(state.outgoing?.messages ?? [], message)
            ) {
                return { state, effects: [] };
            }
            if (state.isCompacting || state.pending.length > 0) {
                return { state: { ...state, pending: [...state.pending, message] }, effects: [] };
            }
            if (!state.outgoing) {
                return oversized(message, context)
                    ? startCompaction(state, [message], [message], undefined)
                    : submitSplit(state, split([message], context), context);
            }
            const combined = [...state.outgoing.messages, message];
            const chunks = split(combined, context);
            if (context.canCompact && chunks.remaining.length > 0) {
                return startCompaction(state, combined, [message], state.outgoing);
            }
            if (chunks.fits.length > state.outgoing.messages.length)
                return submitSplit(state, chunks, context);
            return { state: { ...state, pending: [message] }, effects: [] };
        }
        case "RequestReceived": {
            if (state.seenIncoming.has(event.request.requestId)) return { state, effects: [] };
            const expiry = nextExpiry(state.expiry, context.nowMs());
            const seenIncoming = new Set(state.seenIncoming).add(event.request.requestId);
            return {
                state: { ...state, seenIncoming, expiry },
                effects: [
                    { kind: "RequestReceived", request: event.request },
                    {
                        kind: "SubmitResponse",
                        response: {
                            requestId: event.request.requestId,
                            expiry,
                            responseCode: PROTOCOL_ACK_CODE,
                        },
                    },
                ],
            };
        }
        case "ResponseReceived": {
            const outgoing = state.outgoing;
            if (!outgoing || event.response.requestId !== outgoing.requestId)
                return { state, effects: [] };
            const delivered: SessionEffect = {
                kind: "ResponseReceived",
                messages: outgoing.messages,
            };
            if (state.isCompacting || state.pending.length === 0) {
                return { state: { ...state, outgoing: undefined }, effects: [delivered] };
            }
            const cleared: Active = { ...state, outgoing: undefined };
            const chunks = split(state.pending, context);
            const step =
                context.canCompact && chunks.remaining.length > 0
                    ? startCompaction(cleared, state.pending, state.pending, undefined)
                    : submitSplit(cleared, chunks, context);
            return { state: step.state, effects: [delivered, ...step.effects] };
        }
        case "CompactionCompleted": {
            if (!state.isCompacting) return { state, effects: [] };
            const originals = event.batches.flatMap((batch) => batch.originals);
            const commits = event.batches.map((batch) => batch.commit);
            const inFlight = without(state.outgoing?.messages ?? [], originals);
            const rest = without(state.pending, originals);
            const chunks = split([...inFlight, ...commits, ...rest], context);
            const overflowingOriginals = chunks.remaining.filter(
                (message) => !containsBytes(commits, message),
            );
            const step =
                context.canCompact && overflowingOriginals.length > 0
                    ? submitSplit(state, chunks, context, overflowingOriginals)
                    : submitSplit(state, chunks, context);
            return {
                state: step.state,
                effects: [
                    ...step.effects,
                    ...event.batches.map((batch) => ({
                        kind: "MessagesCompacted" as const,
                        batch,
                    })),
                ],
            };
        }
        case "CompactionFailed": {
            if (!state.isCompacting) return { state, effects: [] };
            const tooLarge = state.pending.filter((message) => oversized(message, context));
            const sendable = state.pending.filter((message) => !oversized(message, context));
            const reports: SessionEffect[] = tooLarge.map((message) => ({
                kind: "MessageTooLarge",
                message,
            }));
            const idle: Active = { ...state, isCompacting: false };
            if (!state.outgoing) {
                if (sendable.length === 0)
                    return { state: { ...idle, pending: [] }, effects: reports };
                const step = submitSplit(idle, split(sendable, context), context);
                return { state: step.state, effects: [...reports, ...step.effects] };
            }
            const chunks = split([...state.outgoing.messages, ...sendable], context);
            if (chunks.fits.length > state.outgoing.messages.length) {
                const step = submitSplit(idle, chunks, context);
                return { state: step.state, effects: [...reports, ...step.effects] };
            }
            return { state: { ...idle, pending: sendable }, effects: reports };
        }
        case "InvalidateSession":
            return {
                state: { kind: "Initialization", pending: state.pending },
                effects: [{ kind: "StopPolling" }, { kind: "FetchInitialData" }],
            };
        default:
            return { state, effects: [] };
    }
}
