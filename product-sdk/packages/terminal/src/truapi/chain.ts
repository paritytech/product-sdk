// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * JSON-RPC connections for the truapi core, over Node's global `WebSocket`
 * (Node >= 22). The core runs its own chainHead state machine on top; this
 * layer only moves strings.
 */

/** The connection shape truapi-host's `ChainProvider.connect` must return. */
export interface JsonRpcConnection {
    send(request: string): void;
    responses(): AsyncIterable<string>;
    close(): void;
}

/** Minimal WebSocket surface used, so tests can pass a fake. */
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: "open" | "close" | "error", listener: () => void): void;
    addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const OPEN = 1;

export function openJsonRpcConnection(
    endpoint: string,
    createSocket: (url: string) => WebSocketLike = (url) =>
        new WebSocket(url) as unknown as WebSocketLike,
): JsonRpcConnection {
    const ws = createSocket(endpoint);
    const queue: string[] = [];
    const waiters: Array<(r: IteratorResult<string>) => void> = [];
    const pending: string[] = [];
    let closed = false;

    const finish = () => {
        closed = true;
        while (waiters.length) waiters.shift()!({ value: undefined, done: true });
    };
    ws.addEventListener("open", () => {
        for (const m of pending.splice(0)) ws.send(m);
    });
    ws.addEventListener("message", (event) => {
        const msg = String(event.data);
        const waiter = waiters.shift();
        if (waiter) waiter({ value: msg, done: false });
        else queue.push(msg);
    });
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);

    return {
        send(request) {
            if (closed) return;
            if (ws.readyState === OPEN) ws.send(request);
            else pending.push(request);
        },
        responses() {
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next(): Promise<IteratorResult<string>> {
                            if (queue.length)
                                return Promise.resolve({ value: queue.shift()!, done: false });
                            if (closed) return Promise.resolve({ value: undefined, done: true });
                            return new Promise((resolve) => waiters.push(resolve));
                        },
                        return(): Promise<IteratorResult<string>> {
                            return Promise.resolve({ value: undefined, done: true });
                        },
                    };
                },
            };
        },
        close() {
            if (closed) return;
            finish();
            ws.close();
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    function fakeSocket() {
        const listeners: Record<string, Array<(e?: { data: unknown }) => void>> = {};
        const sent: string[] = [];
        const socket = {
            readyState: 0,
            send: (d: string) => sent.push(d),
            close: () => socket.emit("close"),
            addEventListener: (t: string, l: (e?: { data: unknown }) => void) => {
                if (!listeners[t]) listeners[t] = [];
                listeners[t].push(l);
            },
            emit(t: string, e?: { data: unknown }) {
                for (const l of listeners[t] ?? []) l(e);
            },
        };
        return { socket, sent };
    }

    describe("openJsonRpcConnection", () => {
        test("buffers sends until open, then flushes in order", () => {
            const { socket, sent } = fakeSocket();
            const conn = openJsonRpcConnection("wss://x", () => socket as never);
            conn.send("a");
            conn.send("b");
            expect(sent).toEqual([]);
            socket.readyState = 1;
            socket.emit("open");
            conn.send("c");
            expect(sent).toEqual(["a", "b", "c"]);
        });

        test("delivers messages to the iterator, queued or awaited", async () => {
            const { socket } = fakeSocket();
            const conn = openJsonRpcConnection("wss://x", () => socket as never);
            const it = conn.responses()[Symbol.asyncIterator]();
            socket.emit("message", { data: "early" });
            expect(await it.next()).toEqual({ value: "early", done: false });
            const awaited = it.next();
            socket.emit("message", { data: "late" });
            expect(await awaited).toEqual({ value: "late", done: false });
        });

        test("ends the iterator on close", async () => {
            const { socket } = fakeSocket();
            const conn = openJsonRpcConnection("wss://x", () => socket as never);
            const it = conn.responses()[Symbol.asyncIterator]();
            const next = it.next();
            conn.close();
            expect(await next).toEqual({ value: undefined, done: true });
        });
    });
}
