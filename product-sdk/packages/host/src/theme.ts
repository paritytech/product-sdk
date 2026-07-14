// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's theme subscription, backed by
 * `truApi.theme.subscribe`.
 *
 * `getThemeProvider` returns a handle whose `subscribeTheme(cb)` delivers a
 * typed {@link ThemeMode} — a `{ name, variant }` struct where `variant` is
 * `"Light" | "Dark"` and `name` is `{ tag: "Default" }` or
 * `{ tag: "Custom", value }` — and yields a {@link HostSubscription}
 * (`unsubscribe` + `onInterrupt`).
 *
 * @module
 */

import type { HostThemeSubscribeItem, TrUApiClient } from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import type { HostSubscription } from "./types.js";

/**
 * Host theme value. A `{ name, variant }` struct re-exported from
 * `@parity/truapi`.
 */
export type ThemeMode = HostThemeSubscribeItem;

/** Light/dark variant of the active theme (`"Light" | "Dark"`) and the active theme name. Re-exported from `@parity/truapi`. */
export type { ThemeName, ThemeVariant } from "@parity/truapi";

/**
 * Host theme provider handle. `subscribeTheme(callback)` receives a typed
 * {@link ThemeMode} on every change and returns a {@link HostSubscription}.
 */
export interface ThemeProvider {
    subscribeTheme(callback: (theme: ThemeMode) => void): HostSubscription;
}

/** Build a {@link ThemeProvider} over a TruAPI client's `theme` domain. */
function adaptThemeProvider(client: TrUApiClient): ThemeProvider {
    return {
        subscribeTheme(callback) {
            return subscribeWithInterrupt(client.theme.subscribe(), callback);
        },
    };
}

/**
 * Get the host theme provider, backed by `truApi.theme.*`. Returns `null` when
 * running outside a host container.
 *
 * @returns The theme provider, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getThemeProvider } from "@parity/product-sdk-host";
 *
 * const provider = await getThemeProvider();
 * if (provider) {
 *   const sub = provider.subscribeTheme((theme) => {
 *     document.documentElement.dataset.theme = theme.variant.toLowerCase();
 *     if (theme.name.tag === "Custom") loadCustomTheme(theme.name.value);
 *   });
 *   // sub.unsubscribe() to stop listening
 * }
 * ```
 */
export async function getThemeProvider(): Promise<ThemeProvider | null> {
    const client = await getClient();
    return client ? adaptThemeProvider(client) : null;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getThemeProvider returns null outside a container", async () => {
        expect(await getThemeProvider()).toBeNull();
    });
}
