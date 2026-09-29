// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's locale subscription, backed by
 * `truApi.locale.subscribe`.
 *
 * `getLocaleProvider` returns a handle whose `subscribeLocale(cb)` delivers a
 * typed {@link LocaleInfo} — a `{ languageTag }` struct carrying a BCP 47 tag
 * such as `"en"`, `"pt-BR"` or `"zh-Hans"` — and yields a
 * {@link HostSubscription} (`unsubscribe` + `onInterrupt`).
 *
 * @module
 */

import type { HostLocaleSubscribeItem, TrUApiClient } from "@parity/truapi";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import type { HostSubscription } from "./types.js";

/**
 * Host locale value. A `{ languageTag }` struct re-exported from
 * `@parity/truapi`.
 */
export type LocaleInfo = HostLocaleSubscribeItem;

/**
 * Host locale provider handle. `subscribeLocale(callback)` receives a typed
 * {@link LocaleInfo} on every change and returns a {@link HostSubscription}.
 */
export interface LocaleProvider {
    subscribeLocale(callback: (locale: LocaleInfo) => void): HostSubscription;
}

/** Build a {@link LocaleProvider} over a TruAPI client's `locale` domain. */
function adaptLocaleProvider(client: TrUApiClient): LocaleProvider {
    return {
        subscribeLocale(callback) {
            return subscribeWithInterrupt(client.locale.subscribe(), callback);
        },
    };
}

/**
 * Get the host locale provider, backed by `truApi.locale.*`. Returns `null`
 * when running outside a host container.
 *
 * The tag is whatever the host reports; a product that ships no catalog entry
 * for it chooses its own fallback.
 *
 * @returns The locale provider, or `null` if unavailable.
 *
 * @example
 * ```ts
 * import { getLocaleProvider } from "@parity/product-sdk-host";
 *
 * const provider = await getLocaleProvider();
 * if (provider) {
 *   const sub = provider.subscribeLocale((locale) => {
 *     i18n.activate(SUPPORTED.has(locale.languageTag) ? locale.languageTag : "en");
 *   });
 *   // sub.unsubscribe() to stop listening
 * }
 * ```
 */
export async function getLocaleProvider(): Promise<LocaleProvider | null> {
    const client = await getClient();
    return client ? adaptLocaleProvider(client) : null;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("getLocaleProvider returns null outside a container", async () => {
        expect(await getLocaleProvider()).toBeNull();
    });
}
