// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Can a follow interrupt actually be lost through real code?
 *
 * `subscribeWithInterrupt` can only call a callback the caller registers after
 * it returns, so an interrupt raised while `subscribe` is still running has
 * nowhere to go. That it is dropped is easy to show against a hand-written
 * observable; what matters is whether the real client can raise one there.
 *
 * This builds the real stack — `createTransport` over a `WireProvider`, the
 * generated `createClient`, and `createHostPapiProvider` — and fakes only the
 * pipe, whose `postMessage` throws the way a closed provider does. Nothing on
 * the path under test is a stand-in.
 *
 * @module
 */

import { createClient, createTransport } from "@parity/truapi";
import type { WireProvider } from "@parity/truapi";
import { describe, expect, test, vi } from "vitest";

import { createHostPapiProvider } from "./papi-provider.js";

/** A pipe whose send throws once a close has been declared, like a dead one. */
function brittlePipe() {
    let inbound: ((message: Uint8Array) => void) | undefined;
    const state = { failSends: false, sent: 0 };
    const provider: WireProvider = {
        postMessage() {
            state.sent += 1;
            if (state.failSends) throw new Error("provider already closed");
        },
        subscribe(callback) {
            inbound = callback;
            return () => {
                inbound = undefined;
            };
        },
        dispose() {
            inbound = undefined;
        },
    };
    return { provider, state, deliver: (frame: Uint8Array) => inbound?.(frame) };
}

describe("a follow interrupt raised while subscribe is still running", () => {
    test("is reachable through the real client, and strands the follow", async () => {
        vi.useFakeTimers();
        const { provider, state } = brittlePipe();
        const client = createClient(createTransport(provider));

        // The pipe dies before the follow goes out, so the client's own send
        // throws inside `subscribe` rather than failing asynchronously later.
        state.failSends = true;

        const messages: unknown[] = [];
        const connection = createHostPapiProvider(
            client,
            "0xfeed",
        )((message) => messages.push(message));
        connection.send({
            jsonrpc: "2.0",
            id: 1,
            method: "chainHead_v1_follow",
            params: [true],
        } as never);

        // Let every timer the provider might have armed fire.
        await vi.advanceTimersByTimeAsync(10_000);

        const followResponse = messages.find((message) => (message as { id?: number }).id === 1) as
            | { result?: string; error?: unknown }
            | undefined;
        const stopped = messages.some(
            (message) =>
                (message as { params?: { result?: { event?: string } } }).params?.result?.event ===
                "stop",
        );

        // Either outcome is acceptable on its own: refusing the follow outright,
        // or accepting it and later telling the consumer to refollow. What must
        // not happen is accepting it and then going silent, which leaves PAPI
        // holding an id the host will never answer for.
        const acceptedTheFollow =
            followResponse?.result !== undefined && followResponse.error === undefined;
        expect(
            !acceptedTheFollow || stopped,
            `follow accepted as ${JSON.stringify(followResponse)} with no stop ever sent; ` +
                `${state.sent} frame(s) attempted`,
        ).toBe(true);

        vi.useRealTimers();
    });
});
