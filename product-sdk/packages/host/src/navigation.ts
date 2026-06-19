// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's deep-link navigation.
 *
 * `truApi.system.navigateTo` returns a neverthrow `ResultAsync`; consumers
 * still have to unwrap it themselves. {@link navigateTo} collapses that to a
 * throw-on-error Promise that matches the shape of {@link requestPermission}
 * and {@link deriveEntropy}.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { formatHostError, getTruApi } from "./truapi.js";

const log = createLogger("host:navigation");

/**
 * Ask the host to navigate to a URL (deep link or external link).
 *
 * Calls `truApi.system.navigateTo` and unwraps the response. The host resolves
 * the destination itself — a `dot`-suffixed deep link (e.g.
 * `"https://search.dot"`) routes to another app/route inside the container, an
 * `https://` URL opens externally.
 *
 * @param url - The URL to navigate to.
 * @throws If the host is unavailable, denies the navigation
 *   (`NavigateToErr::PermissionDenied`), or fails for any other reason
 *   (`NavigateToErr::Unknown`).
 *
 * @example
 * ```ts
 * import { navigateTo } from "@parity/product-sdk-host";
 *
 * await navigateTo("https://search.dot");
 * ```
 */
export async function navigateTo(url: string): Promise<void> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("navigateTo: TruAPI unavailable");
    }
    log.debug("navigateTo", { url });

    // `.match()` because the host returns a neverthrow ResultAsync, not a Promise.
    await truApi.system.navigateTo({ url }).match(
        () => undefined,
        (err: unknown) => {
            throw new Error(`navigateTo failed: ${formatHostError(err)}`, { cause: err });
        },
    );
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: { system?: { navigateTo?: (req: unknown) => unknown } } | null,
        fn: (mod: typeof import("./navigation.js")) => Promise<T>,
    ): Promise<T> {
        vi.resetModules();
        vi.doMock("./truapi.js", async (importOriginal) => {
            const original = await importOriginal<typeof import("./truapi.js")>();
            return {
                ...original,
                getTruApi: async () => bridge,
            };
        });
        try {
            const mod = await import("./navigation.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    describe("navigateTo", () => {
        test("throws when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                await expect(mod.navigateTo("https://search.dot")).rejects.toThrow(
                    /TruAPI unavailable/,
                );
            });
        });

        test("resolves on success", async () => {
            await withMockedTruApi(
                {
                    system: {
                        navigateTo: vi.fn().mockReturnValue({
                            match: async (onOk: (v: unknown) => unknown) => onOk(undefined),
                        }),
                    },
                },
                async (mod) => {
                    await expect(mod.navigateTo("https://search.dot")).resolves.toBeUndefined();
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    system: {
                        navigateTo: vi.fn().mockReturnValue({
                            match: async (
                                _onOk: (v: unknown) => unknown,
                                onErr: (e: unknown) => unknown,
                            ) => onErr({ tag: "PermissionDenied" }),
                        }),
                    },
                },
                async (mod) => {
                    await expect(mod.navigateTo("https://search.dot")).rejects.toThrow(
                        /navigateTo failed: PermissionDenied/,
                    );
                },
            );
        });
    });
}
