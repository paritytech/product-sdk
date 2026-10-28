// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { getLocaleProvider } from "@parity/product-sdk-host";
import type { HostController } from "./host.js";
import { type ReadonlyStore, createLazyStore } from "./store.js";

export interface LocaleState {
    /** BCP 47 language tag (`en`, `pt-BR`, `zh-Hans`). */
    languageTag: string;
    /** Where the tag came from: the host's own language setting, or `navigator.language`. */
    source: "host" | "navigator";
}

function navigatorLocale(): LocaleState {
    return { languageTag: globalThis.navigator?.language || "en", source: "navigator" };
}

/**
 * The language the host presents its own interface in when embedded
 * (`Locale.subscribe`), `navigator.language` standalone — subscribers get a
 * live value either way. The set of tags is open: a product that ships no
 * catalog for the tag it receives picks its own fallback.
 */
export function createLocaleStore(host: HostController): ReadonlyStore<LocaleState> {
    return createLazyStore<LocaleState>(navigatorLocale(), (set) => {
        let cancelled = false;
        let teardown: (() => void) | undefined;

        void host.detect().then(async (inside) => {
            if (cancelled) return;
            if (inside) {
                const provider = await getLocaleProvider();
                if (cancelled || !provider) return;
                const sub = provider.subscribeLocale((locale) => {
                    set({ languageTag: locale.languageTag, source: "host" });
                });
                // A host that predates the locale domain ends the subscription; keep
                // rendering with the navigator's language instead of freezing.
                const offInterrupt = sub.onInterrupt(() => set(navigatorLocale()));
                teardown = () => {
                    offInterrupt();
                    sub.unsubscribe();
                };
            } else if (globalThis.addEventListener) {
                const onChange = () => set(navigatorLocale());
                onChange();
                globalThis.addEventListener("languagechange", onChange);
                teardown = () => globalThis.removeEventListener("languagechange", onChange);
            }
        });

        return () => {
            cancelled = true;
            teardown?.();
        };
    });
}
