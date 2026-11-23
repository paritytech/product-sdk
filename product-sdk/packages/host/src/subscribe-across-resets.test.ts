// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * A host connection reset ends every stream the product opened. The host keeps
 * the chat and renderer action streams' items while no stream is open, so the
 * product loses nothing as long as it opens the stream again; one that does not
 * reopen goes deaf to every tap until the product restarts.
 *
 * These run the real `createTransport` and generated `createClient` over a fake
 * pipe, so the error a reset produces is the one the product actually sees. The
 * connection status is driven through the test seam.
 *
 * @module
 */

import { ConnectionResetError, createClient, createTransport } from "@parity/truapi";
import type { WireProvider } from "@parity/truapi";
import { afterEach, expect, test } from "vitest";

import {
    emitConnectionStatus,
    setTruApiClient,
    subscribeAcrossResets,
    subscribeConnectionStatus,
} from "./transport.js";

/** A pipe that can reset the way the host connection does when its socket dies. */
function resettablePipe() {
    let reset: ((error: Error) => void) | undefined;
    const provider: WireProvider = {
        postMessage() {},
        subscribe() {
            return () => {};
        },
        subscribeReset(callback) {
            reset = callback;
            return () => {
                reset = undefined;
            };
        },
        dispose() {},
    };
    return { provider, reset: () => reset?.(new ConnectionResetError()) };
}

function chatActions() {
    const pipe = resettablePipe();
    const client = createClient(createTransport(pipe.provider));
    setTruApiClient(client);
    let opened = 0;
    let closed = 0;
    const interrupts: unknown[] = [];
    const subscription = subscribeAcrossResets(
        () => {
            opened += 1;
            const stream = client.chat.actionSubscribe();
            const subscribe = stream.subscribe.bind(stream);
            stream.subscribe = (observer) => {
                const opening = subscribe(observer);
                return {
                    ...opening,
                    unsubscribe() {
                        closed += 1;
                        opening.unsubscribe();
                    },
                };
            };
            return stream;
        },
        () => {},
    );
    subscription.onInterrupt((reason) => interrupts.push(reason));
    return {
        subscription,
        reset: pipe.reset,
        get opened() {
            return opened;
        },
        get closed() {
            return closed;
        },
        interrupts,
    };
}

afterEach(() => setTruApiClient(null));

test("a stream a reset ended opens again once the host is connected again", () => {
    const actions = chatActions();

    actions.reset();
    // Still "connected": the stream ends before the status changes, and the host
    // is not listening again yet.
    expect(actions.opened).toBe(1);

    emitConnectionStatus("disconnected");
    expect(actions.opened).toBe(1);

    emitConnectionStatus("connected");
    expect(actions.opened).toBe(2);
    expect(actions.interrupts).toEqual([]);
});

test("a stream survives every reset, not only the first", () => {
    const actions = chatActions();

    for (let round = 0; round < 3; round += 1) {
        actions.reset();
        emitConnectionStatus("disconnected");
        emitConnectionStatus("connected");
    }

    expect(actions.opened).toBe(4);
    expect(actions.interrupts).toEqual([]);
});

test("a stream unsubscribed while waiting for the host is not opened again", () => {
    const actions = chatActions();

    actions.reset();
    actions.subscription.unsubscribe();
    emitConnectionStatus("disconnected");
    emitConnectionStatus("connected");

    expect(actions.opened).toBe(1);
});

// The status fan-out calls every listener it had when the status changed, so a
// product reacting to "connected" can unsubscribe a stream whose wait still runs.
test("a stream unsubscribed by another listener of the same status is left closed", () => {
    const actions = chatActions();
    let reset = false;
    const stopOnConnected = subscribeConnectionStatus((status) => {
        if (reset && status === "connected") actions.subscription.unsubscribe();
    });

    actions.reset();
    reset = true;
    emitConnectionStatus("disconnected");
    emitConnectionStatus("connected");
    stopOnConnected();

    // The reset ended the first stream. Any stream opened after that is closed.
    expect(actions.opened - actions.closed).toBe(1);
});

// The product can unsubscribe from the first item, and a stream can deliver one
// before it has finished opening.
test("a stream unsubscribed while it opens again is closed", () => {
    setTruApiClient({} as never);
    let fail: ((reason: unknown) => void) | undefined;
    let closed = 0;
    const subscription = subscribeAcrossResets(
        () =>
            ({
                subscribe(observer: {
                    next?: (item: unknown) => void;
                    error?: (reason: unknown) => void;
                }) {
                    if (fail === undefined) fail = (reason) => observer.error?.(reason);
                    else observer.next?.("delivered while opening");
                    return {
                        subscriptionId: "1",
                        unsubscribe() {
                            closed += 1;
                        },
                    };
                },
            }) as never,
        () => subscription.unsubscribe(),
    );

    fail?.(new ConnectionResetError());
    emitConnectionStatus("disconnected");
    emitConnectionStatus("connected");

    expect(closed).toBe(1);
});

// A host that ends the stream itself has answered; opening it again would only
// be refused the same way.
test("an interrupt other than a reset ends the stream", () => {
    const interrupts: unknown[] = [];
    let opened = 0;
    const subscription = subscribeAcrossResets(
        () => {
            opened += 1;
            return {
                subscribe(observer: { error?: (reason: unknown) => void }) {
                    observer.error?.(new Error("host went away"));
                    return { subscriptionId: "1", unsubscribe() {} };
                },
            } as never;
        },
        () => {},
    );
    subscription.onInterrupt((reason) => interrupts.push(reason));
    setTruApiClient({} as never);
    emitConnectionStatus("disconnected");
    emitConnectionStatus("connected");

    expect(opened).toBe(1);
    expect(interrupts).toEqual([new Error("host went away")]);
});
