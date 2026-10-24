// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's scheduled push-notification surface (RFC-0019),
 * backed by `truApi.notifications.*`.
 *
 * `getNotificationManager()` returns a handle exposing `push(input)` (resolves
 * to a {@link NotificationId}) and `cancel(id)`, matching the singleton
 * pattern already used by {@link getPaymentManager}, {@link getPreimageManager},
 * and {@link getHostLocalStorage}.
 *
 * @module
 */

import type { HostPushNotificationRequest, TrUApiClient } from "@parity/truapi";

import { roomDeeplink } from "./chat-rooms.js";
import { getClient } from "./transport.js";
import { unwrapHostResult } from "./truapi.js";

/**
 * Error variants the host raises when scheduling a push notification.
 *
 * A `{ tag }` tagged union re-exported from `@parity/truapi`:
 * `{ tag: "ScheduleLimitReached" }` (the host-wide pending-notification cap) or
 * `{ tag: "Unknown"; value: { reason } }`. {@link NotificationManager.push} /
 * {@link NotificationManager.cancel} reject with an `Error` whose `cause`
 * carries this value, so branch on it — e.g.
 * `(err as Error).cause?.tag === "ScheduleLimitReached"`.
 */
export type { HostPushNotificationError as PushNotificationError } from "@parity/truapi";

/**
 * Host-assigned id for a scheduled notification — pass to
 * {@link NotificationManager.cancel}. truapi 0.23 dropped the `NotificationId`
 * alias and uses the underlying `number` inline; kept here as a named alias so
 * this package's public surface is unchanged.
 */
export type NotificationId = number;

/**
 * Push payload: `text`, an optional `deeplink`, and an optional `scheduledAt`
 * (Unix timestamp in milliseconds; omit for immediate delivery). Re-exported
 * from the truapi wire request type so the shape stays in lockstep with the
 * protocol.
 */
export type PushNotificationInput = HostPushNotificationRequest;

/**
 * Host notification manager handle. Exposes `push(input)` (resolves to a
 * {@link NotificationId}), `pushRoom(roomId, text)` for a notification of one
 * of the product's chat rooms, and `cancel(id)`.
 */
export interface NotificationManager {
    push(input: PushNotificationInput): Promise<NotificationId>;
    /**
     * A notification of one of the product's chat rooms. The host titles it with
     * the room's name (or contact), so `text` carries the message alone, not the
     * sender's name before it. It shows as the in-app banner while the app is in
     * the foreground, except while that room is on screen, and a tap opens the room.
     */
    pushRoom(
        roomId: string,
        text: string,
        options?: Pick<PushNotificationInput, "scheduledAt">,
    ): Promise<NotificationId>;
    cancel(id: NotificationId): Promise<void>;
}

/** Build a {@link NotificationManager} over a TruAPI client's `notifications` domain. */
function adaptNotificationManager(client: TrUApiClient): NotificationManager {
    const notifications = client.notifications;
    const push = async (input: PushNotificationInput) => {
        const response = await unwrapHostResult(
            notifications.sendPushNotification(input),
            "notification push failed",
        );
        return response.id;
    };
    return {
        push,
        pushRoom(roomId, text, options) {
            return push({ text, deeplink: roomDeeplink(roomId), ...options });
        },
        async cancel(id) {
            await unwrapHostResult(
                notifications.cancelPushNotification({ id }),
                "notification cancel failed",
            );
        },
    };
}

/**
 * Get the host notification manager, backed by `truApi.notifications.*`.
 * Returns `null` when running outside a host container.
 *
 * @returns The notification manager, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getNotificationManager, type PushNotificationError } from "@parity/product-sdk-host";
 *
 * const notifications = await getNotificationManager();
 * if (notifications) {
 *   try {
 *     const id = await notifications.push({
 *       text: "Doors open in 1h",
 *       scheduledAt: someUnixMs,
 *     });
 *     // later: await notifications.cancel(id);
 *   } catch (err) {
 *     const cause = (err as Error).cause as PushNotificationError | undefined;
 *     if (cause?.tag === "ScheduleLimitReached") {
 *       // host hit its pending-notification cap — surface to the user
 *     }
 *   }
 * }
 * ```
 */
export async function getNotificationManager(): Promise<NotificationManager | null> {
    const client = await getClient();
    return client ? adaptNotificationManager(client) : null;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getNotificationManager returns null outside a container", async () => {
        expect(await getNotificationManager()).toBeNull();
    });

    test("pushRoom sends the room's deeplink", async () => {
        const { okAsync } = await import("neverthrow");
        const sent: PushNotificationInput[] = [];
        const manager = adaptNotificationManager({
            notifications: {
                sendPushNotification: (input: PushNotificationInput) => {
                    sent.push(input);
                    return okAsync({ id: 7 });
                },
            },
        } as unknown as TrUApiClient);
        expect(await manager.pushRoom("support", "We answered", { scheduledAt: 5n })).toBe(7);
        expect(sent).toEqual([
            { text: "We answered", deeplink: "/-/chat/support", scheduledAt: 5n },
        ]);
    });
}
