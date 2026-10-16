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

/** Called with the socket once created, as requests leave and responses arrive, and when the core closes it. */
interface ConnectionHooks {
    created?(socket: SocketLike): void;
    sent?(request: string): void;
    received?(response: string): void;
    closing?(): void;
}

/**
 * Resolves once the socket is open, so an unreachable endpoint fails the
 * core's connect instead of swallowing its first requests.
 */
export function openJsonRpcConnection(
    endpoint: string,
    openSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as unknown as SocketLike,
    hooks: ConnectionHooks = {},
): Promise<JsonRpcConnection> {
    const socket = openSocket(endpoint);
    hooks.created?.(socket);
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
            const response = String(event.data);
            hooks.received?.(response);
            received.push(response);
            wake?.();
        });
        socket.addEventListener("close", finish);
        socket.addEventListener("error", finish);
        socket.addEventListener("open", () => {
            opened = true;
            resolve({
                send(request) {
                    if (closed) return;
                    socket.send(request);
                    hooks.sent?.(request);
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
                    hooks.closing?.();
                },
            });
        });
    });
}

/** The chain connections the core uses, with what the terminal needs to see of them. */
export interface TerminalChains {
    provider: ChainProvider;
    /**
     * Resolves `true` once a `statement_submit` request has gone out and been
     * answered, or gone out on a connection the core then closed itself (as it
     * does for a fire-and-forget submit), or `false` after `timeoutMs`. Call it
     * before the action that submits, so the request cannot be missed.
     */
    nextStatementSubmit(timeoutMs: number): Promise<boolean>;
    /** Close every socket, including one still connecting, and refuse new ones. */
    closeAll(): void;
}

function requestId(message: string): unknown {
    try {
        return (JSON.parse(message) as { id?: unknown }).id;
    } catch {
        return undefined;
    }
}

/** Connect each chain the core asks for to the endpoint its genesis hash names, in any case. */
export function createChainProvider(
    endpointByGenesis: ReadonlyMap<string, string>,
    openSocket?: (url: string) => SocketLike,
): TerminalChains {
    const endpoints = new Map(
        [...endpointByGenesis].map(([hash, endpoint]) => [hash.toLowerCase(), endpoint]),
    );
    const sockets = new Set<SocketLike>();
    const submitWaiters = new Set<() => void>();
    let closedAll = false;
    const submitted = () => {
        for (const notify of submitWaiters) notify();
    };

    // Tracked per connection, so one closing cannot stand in for a submit sent on another.
    function connectionHooks(): ConnectionHooks {
        const pendingSubmits = new Set<unknown>();
        return {
            created(socket) {
                sockets.add(socket);
                socket.addEventListener("close", () => sockets.delete(socket));
            },
            sent(request) {
                if (submitWaiters.size > 0 && request.includes('"statement_submit"')) {
                    pendingSubmits.add(requestId(request));
                }
            },
            received(response) {
                if (pendingSubmits.size > 0 && pendingSubmits.delete(requestId(response)))
                    submitted();
            },
            closing() {
                if (pendingSubmits.size === 0) return;
                pendingSubmits.clear();
                submitted();
            },
        };
    }

    return {
        provider: {
            async connect(genesisHash) {
                if (closedAll) throw new Error("The terminal adapter is destroyed");
                const hex = toHex(genesisHash);
                const endpoint = endpoints.get(hex);
                if (!endpoint) throw new Error(`No RPC endpoint configured for chain ${hex}`);
                return openJsonRpcConnection(endpoint, openSocket, connectionHooks());
            },
        },
        nextStatementSubmit(timeoutMs) {
            return new Promise((resolve) => {
                const settle = (answered: boolean) => {
                    clearTimeout(timer);
                    submitWaiters.delete(onAnswered);
                    resolve(answered);
                };
                const onAnswered = () => settle(true);
                const timer = setTimeout(() => settle(false), timeoutMs);
                submitWaiters.add(onAnswered);
            });
        },
        closeAll() {
            closedAll = true;
            for (const socket of sockets) socket.close();
            sockets.clear();
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
                createChainProvider(new Map()).provider.connect(new Uint8Array([0xab])),
            ).rejects.toThrow(/0xab/);
        });

        // A custom network may spell its genesis hashes in upper case.
        test("matches a genesis hash configured in upper case", async () => {
            await expect(
                createChainProvider(new Map([["0xAB", "ws://127.0.0.1:9"]])).provider.connect(
                    new Uint8Array([0xab]),
                ),
            ).rejects.toThrow("Could not connect to ws://127.0.0.1:9");
        });

        // Logout waits on this, so the wallet's notice is not cut off by teardown.
        test("reports a statement_submit once it is answered, and times out without one", async () => {
            const { socket, sent } = fakeSocket();
            const chains = createChainProvider(
                new Map([["0xab", "wss://x"]]),
                () => socket as never,
            );
            const connecting = chains.provider.connect(new Uint8Array([0xab]));
            socket.emit("open");
            const connection = await connecting;
            const answered = chains.nextStatementSubmit(5_000);
            connection.send(JSON.stringify({ id: 7, method: "chain_getBlockHash", params: [] }));
            connection.send(
                JSON.stringify({ id: 8, method: "statement_submit", params: ["0x00"] }),
            );
            socket.emit("message", { data: JSON.stringify({ id: 7, result: "0x01" }) });
            const beforeAnswer = await Promise.race([answered, Promise.resolve("pending")]);
            socket.emit("message", { data: JSON.stringify({ id: 8, result: { status: "new" } }) });
            expect({
                sent: sent.length,
                beforeAnswer,
                answered: await answered,
                unanswered: await chains.nextStatementSubmit(10),
            }).toEqual({ sent: 2, beforeAnswer: "pending", answered: true, unanswered: false });
        });

        test("counts a statement_submit as delivered when the core closes its connection after sending", async () => {
            const sockets: ReturnType<typeof fakeSocket>[] = [fakeSocket(), fakeSocket()];
            let next = 0;
            const chains = createChainProvider(
                new Map([["0xab", "wss://x"]]),
                () => sockets[next++]!.socket as never,
            );
            const other = chains.provider.connect(new Uint8Array([0xab]));
            sockets[0]!.socket.emit("open");
            const submitting = chains.provider.connect(new Uint8Array([0xab]));
            sockets[1]!.socket.emit("open");
            const [otherConnection, submitConnection] = await Promise.all([other, submitting]);
            const delivered = chains.nextStatementSubmit(5_000);
            submitConnection.send(
                JSON.stringify({ id: "truapi:0", method: "statement_submit", params: ["0x00"] }),
            );
            otherConnection.close();
            const afterOtherClosed = await Promise.race([delivered, Promise.resolve("pending")]);
            submitConnection.close();
            expect([afterOtherClosed, await delivered]).toEqual(["pending", true]);
        });

        test("closeAll closes a socket still connecting and refuses new connections", async () => {
            const { socket } = fakeSocket();
            const chains = createChainProvider(
                new Map([["0xab", "wss://x"]]),
                () => socket as never,
            );
            const connecting = chains.provider.connect(new Uint8Array([0xab]));
            chains.closeAll();
            await expect(connecting).rejects.toThrow("Could not connect to wss://x");
            await expect(chains.provider.connect(new Uint8Array([0xab]))).rejects.toThrow(
                "The terminal adapter is destroyed",
            );
        });
    });
}
