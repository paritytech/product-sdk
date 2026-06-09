// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for the host's scheduled push-notification surface.
 *
 * Shipped flat-in-host rather than as `getTruApi().notification.*` because
 * the upstream JS `hostApi` is itself a flat object - there is no
 * `.notification` accessor to mirror. A flat `getNotificationManager()`
 * matches the singleton pattern already used by {@link getPaymentManager},
 * {@link getPreimageManager}, and {@link getHostLocalStorage}.
 *
 * Returns the shared `notificationManager` singleton from
 * `@novasamatech/host-api-wrapper` (not a fresh `createNotificationManager()`
 * instance) so callers share one wrapper + hostApi closure across the app.
 *
 * {@link PushNotificationError} is re-exported from `@novasamatech/host-api`
 * so consumers can branch on `err instanceof
 * PushNotificationError.ScheduleLimitReached` (the host's pending-notification
 * cap) without importing the novasama packages directly.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import type { notificationManager } from "@novasamatech/host-api-wrapper";

const log = createLogger("host:notifications");

/**
 * Error variants the host raises when scheduling a push notification.
 *
 * A SCALE codec (with a `[Symbol.hasInstance]`), not a plain `Error`
 * subclass: branch with `err instanceof
 * PushNotificationError.ScheduleLimitReached` to detect the host's
 * platform-wide pending-notification cap, or `.Unknown` for everything
 * else. Re-exported from `@novasamatech/host-api` so consumers can
 * `instanceof`-branch without a direct novasama dependency.
 */
export { PushNotificationError } from "@novasamatech/host-api";

/**
 * Host notification manager handle. Exposes `push(input)` (resolves to a
 * {@link NotificationId}) and `cancel(id)`.
 *
 * Type identical to `notificationManager` from
 * `@novasamatech/host-api-wrapper`.
 */
export type NotificationManager = typeof notificationManager;

/**
 * Host-assigned id for a scheduled notification — pass to
 * {@link NotificationManager.cancel}. Derived from the manager's `push`
 * return type so codec changes surface here as compile errors.
 */
export type NotificationId = Awaited<ReturnType<NotificationManager["push"]>>;

/**
 * Push payload: `text`, an optional `deeplink`, and an optional
 * `scheduledAt` (omit for immediate delivery). Derived from the manager's
 * `push` parameter so the shape stays in lockstep with upstream.
 */
export type PushNotificationInput = Parameters<NotificationManager["push"]>[0];

/**
 * Get the host notification manager.
 *
 * Returns the shared `notificationManager` singleton from
 * `@novasamatech/host-api-wrapper`, or `null` if the package is unavailable
 * (running outside a host container or the optional peer dep isn't
 * installed).
 *
 * @returns The notification manager, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getNotificationManager, PushNotificationError } from "@parity/product-sdk-host";
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
 *     if (err instanceof PushNotificationError.ScheduleLimitReached) {
 *       // host hit its pending-notification cap — surface to the user
 *     }
 *   }
 * }
 * ```
 */
export async function getNotificationManager(): Promise<NotificationManager | null> {
    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.notificationManager;
    } catch (err) {
        log.debug("getNotificationManager unavailable", err);
        return null;
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getNotificationManager returns manager with push/cancel when SDK is available", async () => {
        const notifications = await getNotificationManager();
        if (notifications === null) {
            // Acceptable: SDK couldn't load (e.g. peer dep missing in some envs).
            return;
        }
        expect(typeof notifications.push).toBe("function");
        expect(typeof notifications.cancel).toBe("function");
    });

    test("PushNotificationError is re-exported with its ScheduleLimitReached variant", async () => {
        const { PushNotificationError } = await import("./notifications.js");
        expect(PushNotificationError).toBeDefined();
        expect(PushNotificationError.ScheduleLimitReached).toBeDefined();
    });
}
