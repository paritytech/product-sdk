// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The life of a chat product's worker.
 *
 * The host delivers its first query only after the worker's bundle finished its
 * top-level evaluation, and the client buffers only 64 starts per stream until a
 * handler is registered. {@link defineChatWorker} registers every handler at once,
 * answers "unavailable" (asked again once by the host) until the product has
 * started, and, when the product keeps per-identity state, stops and starts it
 * again on a sign-out or an account switch.
 *
 * @module
 */
import {
    type SignedInIdentity,
    type TruApi,
    getTruApiSync,
    watchIdentity,
} from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import type { Clock } from "@parity/product-sdk-utils";

import { type RoomRoutes, serveRoomsOn } from "./router.js";

const log = createLogger("chat:worker");

/** A started product: how it serves its rooms, and how it stops. */
export interface StartedChat extends RoomRoutes {
    /** Called before the product starts again for another identity, or when the worker stops. */
    stop?(): void | Promise<void>;
}

/** What {@link defineChatWorker} runs. */
export interface ChatWorkerDefinition {
    /**
     * Starts the product: opens its storage, declares its rooms, connects to its
     * message source. `identity` is who is signed in, when the definition reads it.
     */
    start(context: { client: TruApi; identity: string | null | undefined }): Promise<StartedChat>;
    /**
     * Reads who is signed in. With it, a change stops the product and, unless the
     * user signed out, starts it again for the new identity.
     */
    identity?(client: TruApi): Promise<SignedInIdentity>;
    /** How often `identity` is read. Default 30 s. */
    identityCheckMs?: number;
    clock?: Clock;
}

/** A running chat worker. */
export interface ChatWorker {
    /** Resolves once the first start finished, or rejects with its error. */
    readonly ready: Promise<void>;
    /** The product as started, or `undefined` while it starts or is signed out. */
    readonly current: StartedChat | undefined;
    /** Stops answering, watching and the product. */
    stop(): Promise<void>;
}

/** {@link defineChatWorker} on a given client. */
export function defineChatWorkerOn(client: TruApi, definition: ChatWorkerDefinition): ChatWorker {
    let current: StartedChat | undefined;
    let stopped = false;
    let stopWatch: (() => void) | undefined;
    const registration = serveRoomsOn(client, () => current);

    const start = async (identity: string | null | undefined) => {
        const started = await definition.start({ client, identity });
        if (stopped) {
            await started.stop?.();
            return;
        }
        current = started;
    };

    const halt = async () => {
        const running = current;
        current = undefined;
        await running?.stop?.();
    };

    const ready = (async () => {
        const identity = definition.identity
            ? await definition.identity(client).catch(() => undefined)
            : undefined;
        if (identity !== null) await start(identity);
        if (!definition.identity || stopped) return;
        const read = definition.identity;
        stopWatch = watchIdentity(
            () => read(client),
            async (next) => {
                await halt();
                if (next === null) {
                    log.info("signed out: the chat stops until an identity signs in");
                    return;
                }
                await start(next).catch((error: unknown) =>
                    log.warn("the chat did not start for the new identity", {
                        reason: error instanceof Error ? error.message : String(error),
                    }),
                );
            },
            {
                current: identity ?? null,
                ...(definition.identityCheckMs !== undefined
                    ? { intervalMs: definition.identityCheckMs }
                    : {}),
                ...(definition.clock ? { clock: definition.clock } : {}),
            },
        );
    })();

    return {
        ready,
        get current() {
            return current;
        },
        async stop() {
            stopped = true;
            stopWatch?.();
            registration.unsubscribe();
            await halt();
        },
    };
}

/**
 * Runs a chat product in this worker, or returns `null` outside a host container.
 * Call it at the top level of the worker's entry, before any `await`.
 *
 * @example
 * ```ts
 * defineChatWorker({
 *     async start({ client }) {
 *         const rooms = await openSupportRooms(client);
 *         return { resolve: (roomId) => rooms.get(roomId), stop: () => rooms.close() };
 *     },
 * });
 * ```
 */
export function defineChatWorker(definition: ChatWorkerDefinition): ChatWorker | null {
    const client = getTruApiSync();
    return client ? defineChatWorkerOn(client, definition) : null;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { createFakeChatHost, createFakeTruApiClient } = await import(
        "@parity/product-sdk-host/testing"
    );
    const { createChatRooms } = await import("@parity/product-sdk-host");
    const { ManualClock } = await import("@parity/product-sdk-utils/testing");

    async function room(host: ReturnType<typeof createFakeChatHost>, client: TruApi) {
        const rooms = createChatRooms(client);
        await rooms.createRoom({ roomId: "r", name: "R", icon: "" });
        await rooms.setConfig("r", {
            productSource: true,
            reactionDetails: false,
            reportSeen: false,
        });
        return host;
    }

    test("queries before the start are unavailable, then served", async () => {
        const host = createFakeChatHost();
        const client = createFakeTruApiClient({ chatHost: host });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const worker = defineChatWorkerOn(client, {
            async start() {
                await gate;
                return { resolve: () => ({ messages: async () => ({ messages: [] }) }) };
            },
        });
        await room(host, client);
        expect((await host.openRoom("r")).ok).toBe(false);
        release();
        await worker.ready;
        expect(await host.openRoom("r")).toEqual({ ok: true, value: { messages: [] } });
        await worker.stop();
    });

    test("an identity change stops the product and starts it for the new identity", async () => {
        const clock = new ManualClock(0);
        const host = createFakeChatHost({ clock });
        const client = createFakeTruApiClient({ chatHost: host });
        const identities = ["alice", "alice", null, "bob"];
        const events: string[] = [];
        const worker = defineChatWorkerOn(client, {
            identity: async () => identities.shift() ?? "bob",
            identityCheckMs: 10,
            clock,
            async start({ identity }) {
                events.push(`start ${identity}`);
                return {
                    resolve: () => undefined,
                    stop: () => void events.push(`stop ${identity}`),
                };
            },
        });
        await worker.ready;
        await clock.advance(40);
        expect(events).toEqual(["start alice", "stop alice", "start bob"]);
        await worker.stop();
        expect(events).toEqual(["start alice", "stop alice", "start bob", "stop bob"]);
    });

    test("defineChatWorker returns null outside a container", () => {
        expect(defineChatWorker({ start: async () => ({ resolve: () => undefined }) })).toBeNull();
    });
}
