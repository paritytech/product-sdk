// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Peer-to-peer media rooms (MoQ-over-iroh) - the product-sdk `p2p` module.
 *
 * Wraps the host's `p2pMedia` TrUAPI service. A p2p room is a session whose
 * "relay" is a loopback endpoint the host serves on `127.0.0.1` and whose
 * remote party is a set of peers: the dapp publishes/subscribes with plain
 * `@moq/*` code pointed at the returned loopback URL, while gossip discovery,
 * hole-punching, and the media relay live in the host.
 *
 * @module
 */

import { scale } from "@parity/truapi";
import type { Codec, TrUApiClient, TrUApiTransport } from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import {
    type HostError,
    type HostErrorPayload,
    HostCallFailedError,
    HostUnavailableError,
} from "./errors.js";
import { type Result, err, ok } from "./result.js";
import { getClient } from "./transport.js";
import type { HostSubscription } from "./types.js";

const log = createLogger("host:p2p");

const IDS = {
    status: { request: 164, response: 165 },
    roomCreate: { request: 166, response: 167 },
    roomJoin: { request: 168, response: 169 },
    roomLeave: { request: 170, response: 171 },
    endpointRefresh: { request: 172, response: 173 },
    publish: { request: 174, response: 175 },
    unpublish: { request: 176, response: 177 },
    roomEvents: { start: 178, stop: 179, interrupt: 180, receive: 181 },
} as const;

/** Protocol version envelope: `V1` = discriminant `0x00`, then the inner. */
function versioned<T>(inner: Codec<T>): Codec<{ tag: "V1"; value: T }> {
    return scale.indexedTaggedUnion({ V1: [0, inner] }) as Codec<{ tag: "V1"; value: T }>;
}

/** V2 wrapper (version byte 1) for requests that grew a trailing field. */
function versionedV2<T>(inner: Codec<T>): Codec<{ tag: "V2"; value: T }> {
    return scale.indexedTaggedUnion({ V2: [1, inner] }) as Codec<{ tag: "V2"; value: T }>;
}

const RtDirections = scale.Struct({
    publishVideo: scale.bool,
    publishAudio: scale.bool,
    receiveVideo: scale.bool,
    receiveAudio: scale.bool,
});

const HostP2pEndpoint = scale.Struct({
    wtUrl: scale.str,
    certSha256: scale.str,
    wsUrl: scale.str,
    expiresAtMs: scale.u64,
});

/** Shared error union - matches the host's `P2pError` (variant order = index). */
const P2pErrorCodec = scale.Enum({
    PermissionDenied: scale._void,
    InvalidTicket: scale._void,
    JoinFailed: scale.str,
    RoomNotFound: scale._void,
    BroadcastMissing: scale.str,
    TooManyRooms: scale._void,
    NotAllowedForModality: scale._void,
    Unsupported: scale._void,
    Unknown: scale.str,
});

const HostP2pStatusResponse = scale.Struct({
    available: scale.bool,
    endpointId: scale.Option(scale.str),
    numRooms: scale.u32,
});

const HostP2pRoomCreateRequest = scale.Struct({
    directions: RtDirections,
    purpose: scale.str,
    displayName: scale.Option(scale.str),
});

// V2: V1 + trailing `directOnly` (iroh relay transport disabled for the
// node - direct paths only, hard-fail without one). Encoded with version
// byte 1; hosts without V2 support reject it, so the SDK only sends V2
// when the caller actually sets `directOnly`.
const HostP2pRoomCreateRequestV2 = scale.Struct({
    directions: RtDirections,
    purpose: scale.str,
    displayName: scale.Option(scale.str),
    directOnly: scale.bool,
});

const HostP2pRoomJoinRequest = scale.Struct({
    ticket: scale.str,
    directions: RtDirections,
    purpose: scale.str,
    displayName: scale.Option(scale.str),
});

// V2 - see HostP2pRoomCreateRequestV2.
const HostP2pRoomJoinRequestV2 = scale.Struct({
    ticket: scale.str,
    directions: RtDirections,
    purpose: scale.str,
    displayName: scale.Option(scale.str),
    directOnly: scale.bool,
});

const HostP2pRoomResponse = scale.Struct({
    room: scale.u64,
    ticket: scale.str,
    endpoint: HostP2pEndpoint,
});

const RoomIdReq = scale.Struct({ room: scale.u64 });
const HostP2pEndpointRefreshResponse = scale.Struct({ endpoint: HostP2pEndpoint });
const NamesReq = scale.Struct({ room: scale.u64, names: scale.Vector(scale.str) });

const HostP2pRoomEventCodec = scale.Enum({
    Active: scale._void,
    PeerJoined: scale.Struct({ peer: scale.str, displayName: scale.Option(scale.str) }),
    PeerLeft: scale.Struct({ peer: scale.str }),
    BroadcastAdded: scale.Struct({ peer: scale.str, name: scale.str }),
    BroadcastRemoved: scale.Struct({ peer: scale.str, name: scale.str }),
    EndpointChanged: HostP2pEndpoint,
    Suspending: scale.Struct({ graceMs: scale.u32 }),
    Resumed: scale._void,
    Revoked: scale.Struct({ reason: scale.str }),
});

/** Which media directions a room wants. All default `false` (receive-only). */
export interface P2pDirections {
    publishVideo?: boolean;
    publishAudio?: boolean;
    receiveVideo?: boolean;
    receiveAudio?: boolean;
}

/** Options for creating or joining a room. */
export interface P2pRoomOptions {
    /** Requested media directions; publishing folds a camera/mic prompt. */
    directions?: P2pDirections;
    /** Short human-readable purpose, shown in the permission prompt. */
    purpose: string;
    /** Per-room presence display name. */
    displayName?: string;
    /**
     * Transport policy: `true` binds the host's iroh node with the RELAY
     * transport DISABLED - peer connections succeed only over direct
     * (hole-punched) paths and FAIL outright when none can be established,
     * proving every live room is genuinely p2p. Both sides of a room should
     * request the same policy (carry it in the invite). Default `false`
     * keeps the encrypted iroh relay available as a backup path tier.
     */
    directOnly?: boolean;
}

/** The loopback endpoint a dapp dials with `@moq/*` / raw WebTransport. */
export interface P2pEndpoint {
    /** `https://127.0.0.1:<port>/<root>?jwt=<token>` - WebTransport. */
    wtUrl: string;
    /** sha-256 (hex) of the relay's self-signed cert (`serverCertificateHashes`). */
    certSha256: string;
    /** `ws://127.0.0.1:<port>/<root>?jwt=<token>` - WebSocket fallback. */
    wsUrl: string;
    /** Token expiry, unix millis. Refresh via {@link mediaEndpoint}. */
    expiresAtMs: number;
}

/** A created/joined room: the opaque handle, its invite ticket, and endpoint. */
export interface P2pRoom {
    /** Opaque room handle - pass it back to the other `p2p` calls. */
    room: bigint;
    /** The invite: a self-describing compact ticket string. */
    ticket: string;
    endpoint: P2pEndpoint;
}

/** Host p2p capability + node info. */
export interface P2pStatus {
    available: boolean;
    /** The node's stable iroh endpoint id (hex), when running. */
    endpointId: string | null;
    numRooms: number;
}

/** A room event (roster + broadcast lifecycle + session lifecycle). */
export type P2pRoomEvent =
    | { tag: "Active" }
    | { tag: "PeerJoined"; peer: string; displayName?: string }
    | { tag: "PeerLeft"; peer: string }
    | { tag: "BroadcastAdded"; peer: string; name: string }
    | { tag: "BroadcastRemoved"; peer: string; name: string }
    | { tag: "EndpointChanged"; endpoint: P2pEndpoint }
    | { tag: "Suspending"; graceMs: number }
    | { tag: "Resumed" }
    | { tag: "Revoked"; reason: string };

/**
 * A typed p2p domain error, surfaced on the `err` channel so a dapp can react
 * (e.g. `PermissionDenied` → re-prompt, `TooManyRooms` → free a room). Mirrors
 * the host's `P2pError`.
 */
export type P2pError =
    | { tag: "PermissionDenied" }
    | { tag: "InvalidTicket" }
    | { tag: "JoinFailed"; reason: string }
    | { tag: "RoomNotFound" }
    | { tag: "BroadcastMissing"; name: string }
    | { tag: "TooManyRooms" }
    | { tag: "NotAllowedForModality" }
    | { tag: "Unsupported" }
    | { tag: "Unknown"; reason: string };

/** Error channel for every `p2p` call. */
export type P2pFailure = P2pError | HostError;

// ---------------------------------------------------------------------------
// Transport access + call helpers.
// ---------------------------------------------------------------------------

/**
 * The shared {@link TrUApiTransport} the host client is built on. `p2pMedia`
 * is not a generated client method yet, so we reach the transport the
 * generated sub-clients already share (documented hand-vendored escape hatch;
 * see the module doc). Returns `null` outside a host container.
 */
async function getTransport(): Promise<TrUApiTransport | null> {
    const client = await getClient();
    if (!client) return null;
    // Every sub-client (`account`, `permissions`, …) holds the same transport;
    // it is `private` in the typings but a real runtime field. Any one works.
    const holder = client as unknown as { account?: { transport?: TrUApiTransport } };
    return holder.account?.transport ?? null;
}

const KNOWN_ERROR_TAGS = new Set([
    "PermissionDenied",
    "InvalidTicket",
    "JoinFailed",
    "RoomNotFound",
    "BroadcastMissing",
    "TooManyRooms",
    "NotAllowedForModality",
    "Unsupported",
    "Unknown",
]);

/** Fold a scale-decoded enum value `{ tag, value }` into a public {@link P2pError}. */
function toP2pError(wire: { tag: string; value?: unknown }): P2pError {
    switch (wire.tag) {
        case "JoinFailed":
            return { tag: "JoinFailed", reason: String(wire.value ?? "") };
        case "BroadcastMissing":
            return { tag: "BroadcastMissing", name: String(wire.value ?? "") };
        case "Unknown":
            return { tag: "Unknown", reason: String(wire.value ?? "") };
        default:
            return { tag: wire.tag } as P2pError;
    }
}

/** Map a transport `err` value: a known `P2pError` stays typed; else `HostCallFailedError`. */
function mapFailure(error: unknown, label: string): P2pFailure {
    if (error && typeof error === "object" && "tag" in error) {
        const tag = (error as { tag: unknown }).tag;
        if (typeof tag === "string" && KNOWN_ERROR_TAGS.has(tag)) {
            return toP2pError(error as { tag: string; value?: unknown });
        }
    }
    return new HostCallFailedError(label, error as HostErrorPayload);
}

/** Run a one-shot request, returning a product-sdk {@link Result}. */
async function call<Ok, Out>(
    label: string,
    ids: { request: number; response: number },
    reqPayload: Uint8Array,
    okCodec: Codec<Ok>,
    map: (ok: Ok) => Out,
): Promise<Result<Out, P2pFailure>> {
    const transport = await getTransport();
    if (!transport) {
        return err(new HostUnavailableError(`${label}: TruAPI unavailable`));
    }
    const decodeResponse = (payload: Uint8Array) =>
        versioned(scale.Result(okCodec, P2pErrorCodec)).dec(payload).value;
    return transport
        .request<Ok, { tag: string; value?: unknown }>({ ids, payload: reqPayload, decodeResponse })
        .match(
            (value) => ok(map(value)),
            (error) => err(mapFailure(error, `${label} failed`)),
        );
}

function endpointToPublic(e: {
    wtUrl: string;
    certSha256: string;
    wsUrl: string;
    expiresAtMs: bigint;
}): P2pEndpoint {
    return {
        wtUrl: e.wtUrl,
        certSha256: e.certSha256,
        wsUrl: e.wsUrl,
        expiresAtMs: Number(e.expiresAtMs),
    };
}

function roomToPublic(r: {
    room: bigint;
    ticket: string;
    endpoint: Parameters<typeof endpointToPublic>[0];
}): P2pRoom {
    return { room: r.room, ticket: r.ticket, endpoint: endpointToPublic(r.endpoint) };
}

function directionsWire(d: P2pDirections | undefined) {
    return {
        publishVideo: d?.publishVideo ?? false,
        publishAudio: d?.publishAudio ?? false,
        receiveVideo: d?.receiveVideo ?? false,
        receiveAudio: d?.receiveAudio ?? false,
    };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Probe the host's p2p capability. Never prompts.
 *
 * @returns `ok(P2pStatus)`, or `err(HostUnavailableError)` outside a container.
 *
 * @example
 * ```ts
 * import { p2pStatus } from "@parity/product-sdk-host";
 * const s = await p2pStatus();
 * if (s.ok && s.value.available) { \/* offer the P2P mode *\/ }
 * ```
 */
export async function p2pStatus(): Promise<Result<P2pStatus, P2pFailure>> {
    log.debug("p2pStatus");
    return call(
        "p2pStatus",
        IDS.status,
        versioned(scale._void).enc({ tag: "V1", value: undefined }),
        HostP2pStatusResponse,
        (r) => ({ available: r.available, endpointId: r.endpointId ?? null, numRooms: r.numRooms }),
    );
}

/**
 * Create a room (host side). THE prompting call: folds the `MediaP2p`
 * permission (always, even receive-only) with camera/mic per the requested
 * publish directions into one prompt.
 *
 * @returns `ok(P2pRoom)` (handle + invite ticket + loopback endpoint), or a
 *   typed {@link P2pError} (`PermissionDenied`, `TooManyRooms`,
 *   `NotAllowedForModality`, `Unsupported`) / `HostUnavailableError`.
 */
export async function createRoom(options: P2pRoomOptions): Promise<Result<P2pRoom, P2pFailure>> {
    log.debug("createRoom", { purpose: options.purpose, directOnly: options.directOnly ?? false });
    // V1 unless directOnly is requested: older hosts keep working, and a host
    // without V2 support rejects (rather than silently ignores) the policy.
    const payload = options.directOnly
        ? versionedV2(HostP2pRoomCreateRequestV2).enc({
              tag: "V2",
              value: {
                  directions: directionsWire(options.directions),
                  purpose: options.purpose,
                  displayName: options.displayName,
                  directOnly: true,
              },
          })
        : versioned(HostP2pRoomCreateRequest).enc({
              tag: "V1",
              value: {
                  directions: directionsWire(options.directions),
                  purpose: options.purpose,
                  displayName: options.displayName,
              },
          });
    return call("createRoom", IDS.roomCreate, payload, HostP2pRoomResponse, roomToPublic);
}

/**
 * Join a room by its invite ticket string. Same gating + return shape as
 * {@link createRoom}; adds `InvalidTicket` / `JoinFailed` to the error set.
 */
export async function joinRoom(
    ticket: string,
    options: P2pRoomOptions,
): Promise<Result<P2pRoom, P2pFailure>> {
    log.debug("joinRoom", { directOnly: options.directOnly ?? false });
    const payload = options.directOnly
        ? versionedV2(HostP2pRoomJoinRequestV2).enc({
              tag: "V2",
              value: {
                  ticket,
                  directions: directionsWire(options.directions),
                  purpose: options.purpose,
                  displayName: options.displayName,
                  directOnly: true,
              },
          })
        : versioned(HostP2pRoomJoinRequest).enc({
              tag: "V1",
              value: {
                  ticket,
                  directions: directionsWire(options.directions),
                  purpose: options.purpose,
                  displayName: options.displayName,
              },
          });
    return call("joinRoom", IDS.roomJoin, payload, HostP2pRoomResponse, roomToPublic);
}

/** Leave a room. De-escalation only - no prompt. */
export async function leaveRoom(room: bigint): Promise<Result<void, P2pFailure>> {
    log.debug("leaveRoom");
    const payload = versioned(RoomIdReq).enc({ tag: "V1", value: { room } });
    return call("leaveRoom", IDS.roomLeave, payload, scale._void, () => undefined);
}

/**
 * Re-issue (rotate) the loopback endpoint for a room - a fresh token/cert.
 * Call before {@link P2pEndpoint.expiresAtMs} or on an `EndpointChanged` event.
 */
export async function mediaEndpoint(room: bigint): Promise<Result<P2pEndpoint, P2pFailure>> {
    log.debug("mediaEndpoint");
    const payload = versioned(RoomIdReq).enc({ tag: "V1", value: { room } });
    return call(
        "mediaEndpoint",
        IDS.endpointRefresh,
        payload,
        HostP2pEndpointRefreshResponse,
        (r) => endpointToPublic(r.endpoint),
    );
}

/**
 * Offer broadcast `names` (relative to the product's `self/` scope) to the
 * room. The dapp must be publishing them into the loopback relay (or start
 * within the host's patience) - else `BroadcastMissing`.
 */
export async function publish(room: bigint, names: string[]): Promise<Result<void, P2pFailure>> {
    log.debug("publish", { count: names.length });
    const payload = versioned(NamesReq).enc({ tag: "V1", value: { room, names } });
    return call("publish", IDS.publish, payload, scale._void, () => undefined);
}

/** Withdraw broadcast `names` from the room. */
export async function unpublish(room: bigint, names: string[]): Promise<Result<void, P2pFailure>> {
    log.debug("unpublish", { count: names.length });
    const payload = versioned(NamesReq).enc({ tag: "V1", value: { room, names } });
    return call("unpublish", IDS.unpublish, payload, scale._void, () => undefined);
}

function eventToPublic(wire: { tag: string; value?: unknown }): P2pRoomEvent {
    const v = wire.value as Record<string, unknown> | undefined;
    switch (wire.tag) {
        case "PeerJoined":
            return {
                tag: "PeerJoined",
                peer: String(v?.peer),
                displayName: v?.displayName as string | undefined,
            };
        case "PeerLeft":
            return { tag: "PeerLeft", peer: String(v?.peer) };
        case "BroadcastAdded":
            return { tag: "BroadcastAdded", peer: String(v?.peer), name: String(v?.name) };
        case "BroadcastRemoved":
            return { tag: "BroadcastRemoved", peer: String(v?.peer), name: String(v?.name) };
        case "EndpointChanged":
            return {
                tag: "EndpointChanged",
                endpoint: endpointToPublic(wire.value as Parameters<typeof endpointToPublic>[0]),
            };
        case "Suspending":
            return { tag: "Suspending", graceMs: Number(v?.graceMs) };
        case "Revoked":
            return { tag: "Revoked", reason: String(v?.reason) };
        case "Resumed":
            return { tag: "Resumed" };
        default:
            return { tag: "Active" };
    }
}

/**
 * Subscribe to a room's events (roster + broadcast lifecycle + session
 * lifecycle). **Holding this subscription is the keep-alive signal** - it is
 * what keeps the host node running through app backgrounding, so a live media
 * session must keep it open. `unsubscribe()` ends the keep-alive.
 *
 * @returns a {@link HostSubscription}, or `null` outside a host container.
 */
export async function roomEvents(
    room: bigint,
    callback: (event: P2pRoomEvent) => void,
): Promise<HostSubscription | null> {
    const transport = await getTransport();
    if (!transport) return null;
    log.debug("roomEvents");
    let interruptCallback: ((reason?: unknown) => void) | undefined;
    const sub = transport.subscribeRaw({
        ids: IDS.roomEvents,
        payload: versioned(RoomIdReq).enc({ tag: "V1", value: { room } }),
        onReceive: (payload) => {
            const item = versioned(HostP2pRoomEventCodec).dec(payload).value;
            callback(eventToPublic(item));
        },
        onInterrupt: (payload) => {
            const wire = versioned(P2pErrorCodec).dec(payload).value;
            interruptCallback?.(toP2pError(wire));
        },
        onClose: (error) => interruptCallback?.(error),
    });
    return {
        unsubscribe: () => sub.unsubscribe(),
        onInterrupt: (cb) => {
            interruptCallback = cb;
            return () => {
                if (interruptCallback === cb) interruptCallback = undefined;
            };
        },
    };
}

// ---------------------------------------------------------------------------
// In-source tests (vitest `includeSource`). Exercise the real codecs through a
// fake transport, so a wrong byte layout or mis-wired frame id fails here.
// ---------------------------------------------------------------------------

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    // A fake transport that decodes the request the module sends, and replies
    // with a caller-seeded response (encoded with the module's own codecs).
    interface Seed {
        okBytes?: Uint8Array;
        errBytes?: Uint8Array;
        onRequest?: (payload: Uint8Array) => void;
    }
    function fakeTransport(seeds: Record<number, Seed>) {
        let sub: {
            onReceive: (p: Uint8Array) => void;
            onInterrupt?: (p: Uint8Array) => void;
            onClose?: (e: Error) => void;
        } | null = null;
        return {
            transport: {
                request<Ok, Err>(params: {
                    ids: { request: number };
                    payload: Uint8Array;
                    decodeResponse: (p: Uint8Array) => { success: boolean; value: unknown };
                }) {
                    const seed = seeds[params.ids.request];
                    seed?.onRequest?.(params.payload);
                    const bytes = seed?.okBytes ?? seed?.errBytes;
                    const decoded = params.decodeResponse(bytes ?? new Uint8Array());
                    return {
                        match: async (onOk: (v: Ok) => unknown, onErr: (e: Err) => unknown) =>
                            decoded.success
                                ? onOk(decoded.value as Ok)
                                : onErr(decoded.value as Err),
                    };
                },
                subscribeRaw(params: {
                    onReceive: (p: Uint8Array) => void;
                    onInterrupt?: (p: Uint8Array) => void;
                    onClose?: (e: Error) => void;
                }) {
                    sub = params;
                    return { unsubscribe: () => {} };
                },
            },
            emit: (p: Uint8Array) => sub?.onReceive(p),
            interrupt: (p: Uint8Array) => sub?.onInterrupt?.(p),
        };
    }

    async function withTransport<T>(
        fake: ReturnType<typeof fakeTransport> | null,
        fn: (mod: typeof import("./p2p.js")) => Promise<T>,
    ): Promise<T> {
        vi.resetModules();
        vi.doMock("./transport.js", async (importOriginal) => {
            const original = await importOriginal<typeof import("./transport.js")>();
            return {
                ...original,
                getClient: async () => (fake ? { account: { transport: fake.transport } } : null),
            };
        });
        try {
            return await fn(await import("./p2p.js"));
        } finally {
            vi.doUnmock("./transport.js");
            vi.resetModules();
        }
    }

    const encOk = <T>(codec: Codec<T>, value: T) =>
        versioned(scale.Result(codec, P2pErrorCodec)).enc({
            tag: "V1",
            value: { success: true, value },
        });
    const encErr = <T>(codec: Codec<T>, error: Parameters<typeof P2pErrorCodec.enc>[0]) =>
        versioned(scale.Result(codec, P2pErrorCodec)).enc({
            tag: "V1",
            value: { success: false, value: error },
        });

    const sampleEndpoint = {
        wtUrl: "https://127.0.0.1:5001/?jwt=t",
        certSha256: "abcd",
        wsUrl: "ws://127.0.0.1:5002/?jwt=t",
        expiresAtMs: 1780000000000n,
    };

    describe("codec round-trips (byte layout self-consistency)", () => {
        test("RtDirections preserves every bit in order", () => {
            const v = {
                publishVideo: true,
                publishAudio: false,
                receiveVideo: true,
                receiveAudio: false,
            };
            expect(RtDirections.dec(RtDirections.enc(v))).toEqual(v);
        });
        test("endpoint round-trips (u64 expiry as bigint)", () => {
            expect(HostP2pEndpoint.dec(HostP2pEndpoint.enc(sampleEndpoint))).toEqual(
                sampleEndpoint,
            );
        });
        test("every P2pError variant round-trips at its index", () => {
            for (const e of [
                { tag: "PermissionDenied", value: undefined },
                { tag: "JoinFailed", value: "all peers offline" },
                { tag: "BroadcastMissing", value: "cam" },
                { tag: "Unknown", value: "boom" },
            ] as const) {
                expect(P2pErrorCodec.dec(P2pErrorCodec.enc(e))).toEqual(e);
            }
        });
        test("room event sum type round-trips", () => {
            const ev = { tag: "BroadcastAdded", value: { peer: "p", name: "cam" } } as const;
            expect(HostP2pRoomEventCodec.dec(HostP2pRoomEventCodec.enc(ev))).toEqual(ev);
        });
    });

    describe("public API over a fake transport", () => {
        test("createRoom encodes directions + returns the mapped room", async () => {
            let sentDirections: unknown;
            const fake = fakeTransport({
                [IDS.roomCreate.request]: {
                    okBytes: encOk(HostP2pRoomResponse, {
                        room: 7n,
                        ticket: "roomTICKET",
                        endpoint: sampleEndpoint,
                    }),
                    onRequest: (payload) => {
                        sentDirections =
                            versioned(HostP2pRoomCreateRequest).dec(payload).value.directions;
                    },
                },
            });
            await withTransport(fake, async (mod) => {
                const r = await mod.createRoom({
                    directions: { publishVideo: true },
                    purpose: "call",
                });
                expect(r.ok).toBe(true);
                if (r.ok) {
                    expect(r.value.room).toBe(7n);
                    expect(r.value.ticket).toBe("roomTICKET");
                    expect(r.value.endpoint.wtUrl).toContain("?jwt=");
                    expect(r.value.endpoint.expiresAtMs).toBe(1780000000000);
                }
                expect(sentDirections).toEqual({
                    publishVideo: true,
                    publishAudio: false,
                    receiveVideo: false,
                    receiveAudio: false,
                });
            });
        });

        test("a typed P2pError surfaces on the err channel", async () => {
            const fake = fakeTransport({
                [IDS.roomCreate.request]: {
                    errBytes: encErr(HostP2pRoomResponse, {
                        tag: "PermissionDenied",
                        value: undefined,
                    }),
                },
            });
            await withTransport(fake, async (mod) => {
                const r = await mod.createRoom({ purpose: "x" });
                expect(r.ok).toBe(false);
                if (!r.ok) expect(r.error).toEqual({ tag: "PermissionDenied" });
            });
        });

        test("status maps the response", async () => {
            const fake = fakeTransport({
                [IDS.status.request]: {
                    okBytes: encOk(HostP2pStatusResponse, {
                        available: true,
                        endpointId: "deadbeef",
                        numRooms: 2,
                    }),
                },
            });
            await withTransport(fake, async (mod) => {
                const r = await mod.p2pStatus();
                expect(r.ok).toBe(true);
                if (r.ok)
                    expect(r.value).toEqual({
                        available: true,
                        endpointId: "deadbeef",
                        numRooms: 2,
                    });
            });
        });

        test("outside a host container → HostUnavailableError", async () => {
            await withTransport(null, async (mod) => {
                const r = await mod.p2pStatus();
                expect(r.ok).toBe(false);
                if (!r.ok) expect((r.error as HostError).name).toBe("HostUnavailableError");
            });
        });

        test("roomEvents delivers mapped events then a typed interrupt", async () => {
            const fake = fakeTransport({});
            await withTransport(fake, async (mod) => {
                const events: unknown[] = [];
                const sub = await mod.roomEvents(7n, (e) => events.push(e));
                expect(sub).not.toBeNull();
                let interruptReason: unknown;
                sub?.onInterrupt((reason) => {
                    interruptReason = reason;
                });

                fake.emit(
                    versioned(HostP2pRoomEventCodec).enc({
                        tag: "V1",
                        value: { tag: "Active", value: undefined },
                    }),
                );
                fake.emit(
                    versioned(HostP2pRoomEventCodec).enc({
                        tag: "V1",
                        value: { tag: "BroadcastAdded", value: { peer: "p", name: "cam" } },
                    }),
                );
                expect(events).toEqual([
                    { tag: "Active" },
                    { tag: "BroadcastAdded", peer: "p", name: "cam" },
                ]);

                fake.interrupt(
                    versioned(P2pErrorCodec).enc({
                        tag: "V1",
                        value: { tag: "RoomNotFound", value: undefined },
                    }),
                );
                expect(interruptReason).toEqual({ tag: "RoomNotFound" });
            });
        });
    });
}
