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

import type { HostPushNotificationRequest, NotificationId, TrUApiClient } from "@parity/truapi";

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
 * {@link NotificationManager.cancel}. Re-exported from `@parity/truapi`.
 */
export type { NotificationId };

/**
 * Push payload: `text`, an optional `deeplink`, and an optional `scheduledAt`
 * (Unix timestamp in milliseconds; omit for immediate delivery). Re-exported
 * from the truapi wire request type so the shape stays in lockstep with the
 * protocol.
 */
export type PushNotificationInput = HostPushNotificationRequest;

/**
 * Host notification manager handle. Exposes `push(input)` (resolves to a
 * {@link NotificationId}) and `cancel(id)`.
 */
export interface NotificationManager {
    push(input: PushNotificationInput): Promise<NotificationId>;
    cancel(id: NotificationId): Promise<void>;
}

/** Build a {@link NotificationManager} over a TruAPI client's `notifications` domain. */
function adaptNotificationManager(client: TrUApiClient): NotificationManager {
    const notifications = client.notifications;
    return {
        async push(input) {
            const response = await unwrapHostResult(
                notifications.sendPushNotification(input),
                "notification push failed",
            );
            return response.id;
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
}
