// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * JSON-RPC connections for the truapi core over Node's global `WebSocket`.
 * The core runs chainHead itself; this only moves strings.
 */
import { createLogger } from "@parity/product-sdk-logger";
import type { WebWorkerHostCallbacks } from "@parity/truapi-host/node";
import { toHex } from "@polkadot-api/utils";

const log = createLogger("terminal:chain");

type ChainProvider = WebWorkerHostCallbacks["chain"];
type JsonRpcConnection = Awaited<ReturnType<ChainProvider["connect"]>>;

/** The WebSocket surface used, so a test can pass a fake. */
export interface SocketLike {
    send(data: string): void;
    close(): void;
    addEventListener(type: "open" | "close" | "error", listener: () => void): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/**
 * Resolves once the socket is open, so an unreachable endpoint fails the
 * core's connect instead of swallowing its first requests.
 */
export function openJsonRpcConnection(
    endpoint: string,
    openSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike,
): Promise<JsonRpcConnection> {
    const socket = openSocket(endpoint);
    const received: string[] = [];
    let wake: (() => void) | undefined;
    let opened = false;
    let closed = false;

    return new Promise((resolve, reject) => {
        const finish = () => {
            if (closed) return;
            closed = true;
            wake?.();
            if (!opened) reject(new Error(`Could not connect to ${endpoint}`));
            // The worker protocol has no message for a dropped chain, so it is logged here.
            else log.warn("chain connection closed", { endpoint });
        };
        socket.addEventListener("message", (event) => {
            received.push(String(event.data));
            wake?.();
        });
        socket.addEventListener("close", finish);
        socket.addEventListener("error", finish);
        socket.addEventListener("open", () => {
            opened = true;
            resolve({
                send(request) {
                    if (!closed) socket.send(request);
                },
                async *responses() {
                    while (!closed || received.length > 0) {
                        const response = received.shift();
                        if (response !== undefined) yield response;
                        else
                            await new Promise<void>((resolveWake) => {
                                wake = resolveWake;
                            });
                    }
                },
                close() {
                    if (closed) return;
                    closed = true;
                    wake?.();
                    socket.close();
                },
            });
        });
    });
}

/** Connect each chain the core asks for to the endpoint its genesis hash names, in any case. */
export function createChainProvider(endpointByGenesis: ReadonlyMap<string, string>): ChainProvider {
    const endpoints = new Map(
        [...endpointByGenesis].map(([hash, endpoint]) => [hash.toLowerCase(), endpoint]),
    );
    return {
        async connect(genesisHash) {
            const hex = toHex(genesisHash);
            const endpoint = endpoints.get(hex);
            if (!endpoint) throw new Error(`No RPC endpoint configured for chain ${hex}`);
            return openJsonRpcConnection(endpoint);
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    function fakeSocket() {
        const listeners = new Map<string, ((event?: { data: unknown }) => void)[]>();
        const sent: string[] = [];
        const socket = {
            send: (data: string) => sent.push(data),
            close: () => socket.emit("close"),
            addEventListener: (type: string, listener: (event?: { data: unknown }) => void) => {
                listeners.set(type, [...(listeners.get(type) ?? []), listener]);
            },
            emit(type: string, event?: { data: unknown }) {
                for (const listener of listeners.get(type) ?? []) listener(event);
            },
        };
        return { socket, sent };
    }

    describe("openJsonRpcConnection", () => {
        test("rejects when the endpoint never opens", async () => {
            const { socket } = fakeSocket();
            const connecting = openJsonRpcConnection("wss://x", () => socket as never);
            socket.emit("error");
            await expect(connecting).rejects.toThrow("Could not connect to wss://x");
        });

        test("sends once open, yields responses in arrival order and ends when closed", async () => {
            const { socket, sent } = fakeSocket();
            const connecting = openJsonRpcConnection("wss://x", () => socket as never);
            socket.emit("open");
            const connection = await connecting;
            connection.send("request");
            const responses = connection.responses()[Symbol.asyncIterator]();
            socket.emit("message", { data: "early" });
            const early = await responses.next();
            const late = responses.next();
            socket.emit("message", { data: "late" });
            const afterLate = await late;
            connection.close();
            expect([sent, early, afterLate, await responses.next()]).toEqual([
                ["request"],
                { value: "early", done: false },
                { value: "late", done: false },
                { value: undefined, done: true },
            ]);
        });
    });

    describe("createChainProvider", () => {
        test("refuses a chain it has no endpoint for, naming the genesis hash", async () => {
            await expect(
                createChainProvider(new Map()).connect(new Uint8Array([0xab])),
            ).rejects.toThrow(/0xab/);
        });

        // A custom network may spell its genesis hashes in upper case.
        test("matches a genesis hash configured in upper case", async () => {
            await expect(
                createChainProvider(new Map([["0xAB", "ws://127.0.0.1:9"]])).connect(
                    new Uint8Array([0xab]),
                ),
            ).rejects.toThrow("Could not connect to ws://127.0.0.1:9");
        });
    });
}
