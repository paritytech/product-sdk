// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { getThemeProvider } from "@parity/product-sdk-host";
import type { HostController } from "./host.js";
import { type ReadonlyStore, createLazyStore } from "./store.js";

export interface ThemeState {
    variant: "light" | "dark";
    /** Custom theme name reported by the host, if any. */
    custom: string | null;
    source: "host" | "system";
}

function systemTheme(): ThemeState {
    const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    return { variant: dark ? "dark" : "light", custom: null, source: "system" };
}

/**
 * Host theme when embedded, `prefers-color-scheme` standalone — subscribers
 * get a live theme either way.
 */
export function createThemeStore(host: HostController): ReadonlyStore<ThemeState> {
    return createLazyStore<ThemeState>(systemTheme(), (set) => {
        let cancelled = false;
        let teardown: (() => void) | undefined;

        void host.detect().then(async (inside) => {
            if (cancelled) return;
            if (inside) {
                const provider = await getThemeProvider();
                if (cancelled || !provider) return;
                const sub = provider.subscribeTheme((theme) => {
                    set({
                        variant: theme.variant === "Dark" ? "dark" : "light",
                        custom: theme.name.tag === "Custom" ? theme.name.value : null,
                        source: "host",
                    });
                });
                const offInterrupt = sub.onInterrupt(() => set(systemTheme()));
                teardown = () => {
                    offInterrupt();
                    sub.unsubscribe();
                };
            } else if (globalThis.matchMedia) {
                const query = globalThis.matchMedia("(prefers-color-scheme: dark)");
                const onChange = () => set(systemTheme());
                onChange();
                query.addEventListener("change", onChange);
                teardown = () => query.removeEventListener("change", onChange);
            }
        });

        return () => {
            cancelled = true;
            teardown?.();
        };
    });
}
