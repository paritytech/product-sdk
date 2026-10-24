// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * What the user opened from an entry point of the host.
 *
 * The host gives a chat product what only it reads: a link, a scanned code, a
 * shared link or a username typed in the add-contact panel. It asks `open_link`
 * with a room of the product it shows unless the product answers another, holds
 * the worker until the answer (up to 90 s), and never reads the payload itself.
 *
 * The payload can come from anyone. A handler treats it as untrusted input and
 * asks the user before it acts on it with an effect the user did not ask for,
 * such as a connection or a payment.
 *
 * @module
 */
import type { ProductChatOpenLinkItem, ProductChatOpenLinkRequest } from "@parity/product-sdk-host";

import { ROOM_LIMITS, checkIdentifier, utf8Bytes } from "./limits.js";

/** Handles the payloads that start with its prefix. `rest` is the payload after the prefix. */
export type OpenLinkHandler = (
    rest: string,
    request: ProductChatOpenLinkRequest,
) => Promise<ProductChatOpenLinkItem>;

/**
 * Routes opened payloads to handlers by prefix, the longest prefix first. A payload
 * no handler takes keeps the room of the request.
 *
 * @example
 * ```ts
 * const links = openLinks().on("contact:", async (account) => ({ roomId: await openContactRoom(account) }));
 * serveRooms({ resolve, openLink: links.handle });
 * ```
 */
export class OpenLinkRouter {
    private readonly routes: { prefix: string; handler: OpenLinkHandler }[] = [];

    /** Adds a handler for payloads starting with `prefix`. */
    on(prefix: string, handler: OpenLinkHandler): this {
        this.routes.push({ prefix, handler });
        this.routes.sort((left, right) => right.prefix.length - left.prefix.length);
        return this;
    }

    /** Answers one `open_link`. Bind-free: pass it as it is. */
    readonly handle = async (
        request: ProductChatOpenLinkRequest,
    ): Promise<ProductChatOpenLinkItem> => {
        const payload = request.payload.trim();
        const bytes = utf8Bytes(payload);
        if (
            bytes < ROOM_LIMITS.openLinkPayloadBytes.min ||
            bytes > ROOM_LIMITS.openLinkPayloadBytes.max
        )
            return {};
        const route = this.routes.find((candidate) => payload.startsWith(candidate.prefix));
        if (!route) return {};
        const answer = await route.handler(payload.slice(route.prefix.length), request);
        if (answer.roomId !== undefined) {
            const problem = checkIdentifier(answer.roomId, "room_id");
            if (problem)
                throw new Error(`the room to show is over its bound: ${problem.actual} bytes`);
        }
        return answer;
    };
}

/** A new {@link OpenLinkRouter}. */
export function openLinks(): OpenLinkRouter {
    return new OpenLinkRouter();
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    const request = (payload: string): ProductChatOpenLinkRequest => ({ roomId: "list", payload });

    test("the longest prefix wins and gets the rest of the payload", async () => {
        const seen: string[] = [];
        const links = openLinks()
            .on("chat:", async (rest) => {
                seen.push(`chat ${rest}`);
                return {};
            })
            .on("chat:contact:", async (rest) => {
                seen.push(`contact ${rest}`);
                return { roomId: `dm-${rest}` };
            });
        expect(await links.handle(request(" chat:contact:ab12 "))).toEqual({ roomId: "dm-ab12" });
        expect(await links.handle(request("chat:other"))).toEqual({});
        expect(seen).toEqual(["contact ab12", "chat other"]);
    });

    test("a payload no handler takes, or one over the bound, keeps the room", async () => {
        const links = openLinks().on("x:", async () => ({ roomId: "r" }));
        expect(await links.handle(request("y:1"))).toEqual({});
        expect(await links.handle(request(`x:${"a".repeat(9 * 1024)}`))).toEqual({});
    });

    test("an answer naming a room over the identifier bound is refused", async () => {
        const links = openLinks().on("x:", async () => ({ roomId: "r".repeat(300) }));
        await expect(links.handle(request("x:1"))).rejects.toThrow("over its bound");
    });
}
