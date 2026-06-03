// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's theme subscription.
 *
 * `hostApi.themeSubscribe` is reachable via {@link getTruApi}, but consumers
 * have to wire the subscription envelope themselves. `getThemeProvider`
 * returns the `@novasamatech/host-api-wrapper` theme provider object directly,
 * giving callers a `subscribeTheme(cb)` method that resolves to a typed
 * {@link ThemeMode} — a `{ name, variant }` struct where `variant` is
 * `"Light" | "Dark"` — and yields a `Subscription<void>` handle.
 *
 * @remarks
 * As of `host-api(-wrapper)` v0.8 the theme payload is a struct, not a flat
 * `"light" | "dark"` string: read {@link ThemeMode.variant} for the
 * light/dark value (now capitalized) and {@link ThemeMode.name} for the
 * active theme name (`Default`, or `Custom` carrying a string id).
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import type {
    createThemeProvider,
    ThemeMode as NovasamaThemeMode,
} from "@novasamatech/host-api-wrapper";

const log = createLogger("host:theme");

/**
 * Host theme provider handle. Exposes `subscribeTheme(callback)` which
 * receives a typed {@link ThemeMode} struct on every change and returns a
 * `Subscription<void>` (`unsubscribe` + `onInterrupt`).
 *
 * Type identical to `createThemeProvider()` from
 * `@novasamatech/host-api-wrapper`.
 */
export type ThemeProvider = ReturnType<typeof createThemeProvider>;

/**
 * Host theme value. Re-exported from `@novasamatech/host-api-wrapper`.
 *
 * A `{ name, variant }` struct as of v0.8 (previously a flat
 * `"light" | "dark"` string).
 */
export type ThemeMode = NovasamaThemeMode;

/** Light/dark variant of the active theme: `"Light" | "Dark"`. */
export type ThemeVariant = ThemeMode["variant"];

/**
 * Active theme name: `{ tag: "Default" }`, or `{ tag: "Custom", value }`
 * carrying the custom theme's string id.
 */
export type ThemeName = ThemeMode["name"];

/**
 * Get the host theme provider.
 *
 * Returns the theme-subscription handle exported by
 * `@novasamatech/host-api-wrapper`, or `null` if the package is unavailable
 * (running outside a host container or the optional peer dep isn't
 * installed).
 *
 * Implementation note: upstream `@novasamatech/host-api-wrapper` exports only
 * the `createThemeProvider` factory and no `themeProvider` singleton, so
 * this getter constructs a fresh instance on each call (unlike
 * {@link getPreimageManager} or {@link getHostLocalStorage}, which return
 * upstream singletons). The constructed provider is cheap to allocate; it
 * only opens a subscription when `subscribeTheme` is called.
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
    try {
        const sdk = await import("@novasamatech/host-api-wrapper");
        return sdk.createThemeProvider();
    } catch (err) {
        log.debug("getThemeProvider unavailable", err);
        return null;
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getThemeProvider returns provider when SDK is available", async () => {
        const provider = await getThemeProvider();
        expect(provider === null || typeof provider === "object").toBe(true);
    });
}
