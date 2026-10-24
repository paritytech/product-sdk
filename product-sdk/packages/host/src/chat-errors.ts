// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Errors of the Chat Extension v2 surface.
 *
 * Two directions:
 *
 * - The product calls the host (`createRoom`, `updateFeed`, ...). A refusal the
 *   product is expected to handle arrives as a {@link ChatRoomError} carrying the
 *   host's domain failure (`RateLimited`, `NotOwner`, ...), or as a
 *   {@link FeatureUnavailableError} when the host does not serve the feature.
 * - The host asks the product (`messages_query`, `user_action`, ...). A query
 *   handler throws {@link UnknownRoomError}, {@link UnknownMessageError},
 *   {@link NotAvailableError} or {@link UserActionRejectedError}, and the bindings
 *   turn it into the matching wire answer.
 *
 * @module
 */
import type {
    HostChatCreateRoomError,
    HostChatRoomError,
    HostChatSetRoomFooterError,
    HostChatUpdateFeedError,
    scale,
} from "@parity/truapi";

import {
    HostCallFailedError,
    HostError,
    type HostErrorPayload,
    formatHostError,
} from "./errors.js";

/** A domain failure of a call that changes a room or its messages. */
export type ChatRoomFailure =
    | HostChatRoomError
    | HostChatUpdateFeedError
    | HostChatCreateRoomError
    | HostChatSetRoomFooterError;

/**
 * The host refused a call that changes a room or its messages. `failure` is the
 * host's own answer, so a product branches on its `tag`:
 *
 * ```ts
 * const sent = await rooms.updateFeed(roomId, update);
 * if (!sent.ok && sent.error instanceof ChatRoomError && sent.error.failure.tag === "RateLimited") {
 *     // wait and send again
 * }
 * ```
 */
export class ChatRoomError extends HostError {
    readonly call: string;
    readonly failure: ChatRoomFailure;

    constructor(call: string, failure: ChatRoomFailure) {
        super(`${call}: ${formatHostError(failure)}`, { cause: failure });
        this.name = "ChatRoomError";
        this.call = call;
        this.failure = failure;
    }
}

/**
 * The host does not serve a chat feature: it is older than the call, or the core
 * gives the feature to another product only (`contact_rooms` and HOP media are the
 * person chat product's). `feature` is the name the core uses (`contact_rooms`,
 * `call_buttons`, ...) or the method the host lacks.
 */
export class FeatureUnavailableError extends HostError {
    readonly feature: string;

    constructor(feature: string, message = `the host does not serve ${feature}`) {
        super(message);
        this.name = "FeatureUnavailableError";
        this.feature = feature;
    }
}

const UNSERVED_FEATURE = /this host does not serve ([a-z_]+)/;

/**
 * The error a failed room call becomes. A domain `Unknown` whose reason names a
 * feature the core refused becomes a {@link FeatureUnavailableError}, an
 * `Unsupported` host call one for `call` itself, any other domain failure a
 * {@link ChatRoomError}, and a framework failure a {@link HostCallFailedError}.
 */
export function chatRoomErrorOf(
    call: string,
    payload: scale.CallErrorValue<{ tag: string; value?: unknown }>,
): HostError {
    if (payload.tag === "Unsupported") return new FeatureUnavailableError(call);
    if (payload.tag !== "Domain") return new HostCallFailedError(call, payload as HostErrorPayload);
    const failure = payload.value.value as ChatRoomFailure;
    if (failure.tag === "Unknown") {
        const unserved = UNSERVED_FEATURE.exec(failure.value.reason);
        if (unserved?.[1]) return new FeatureUnavailableError(unserved[1], failure.value.reason);
    }
    return new ChatRoomError(call, failure);
}

/** Thrown by a query handler: the product serves no room with this id. */
export class UnknownRoomError extends Error {
    constructor(roomId: string) {
        super(`unknown room ${roomId}`);
        this.name = "UnknownRoomError";
    }
}

/** Thrown by a user-action handler: the action names a message the room does not hold. */
export class UnknownMessageError extends Error {
    constructor(messageId: string) {
        super(`unknown message ${messageId}`);
        this.name = "UnknownMessageError";
    }
}

/**
 * Thrown by a query handler: the product cannot answer this question, such as for a
 * room too large to track. The host hides the feature for the item and applies its
 * default. Not a failure.
 */
export class NotAvailableError extends Error {
    constructor(message = "not available") {
        super(message);
        this.name = "NotAvailableError";
    }
}

/** Thrown by a user-action handler: the product refuses the action, and the host shows `message` to the user. */
export class UserActionRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UserActionRejectedError";
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("chatRoomErrorOf", () => {
        const domain = (failure: ChatRoomFailure) =>
            ({ tag: "Domain", value: { tag: "V1", value: failure } }) as const;

        test("a domain failure keeps its tag", () => {
            const error = chatRoomErrorOf("updateFeed", domain({ tag: "RateLimited" }));
            expect(error).toBeInstanceOf(ChatRoomError);
            expect((error as ChatRoomError).failure).toEqual({ tag: "RateLimited" });
            expect(error.message).toBe("updateFeed: RateLimited");
        });

        test("a feature the core refuses names that feature", () => {
            const error = chatRoomErrorOf(
                "setContact",
                domain({
                    tag: "Unknown",
                    value: { reason: "this host does not serve contact_rooms" },
                }),
            );
            expect(error).toBeInstanceOf(FeatureUnavailableError);
            expect((error as FeatureUnavailableError).feature).toBe("contact_rooms");
        });

        test("an unsupported call names the call", () => {
            const error = chatRoomErrorOf("setRoomCall", { tag: "Unsupported" });
            expect(error).toBeInstanceOf(FeatureUnavailableError);
            expect((error as FeatureUnavailableError).feature).toBe("setRoomCall");
        });

        test("a framework failure stays a host call failure", () => {
            const error = chatRoomErrorOf("deleteRoom", {
                tag: "HostFailure",
                value: { reason: "gone" },
            });
            expect(error).toBeInstanceOf(HostCallFailedError);
        });
    });
}
