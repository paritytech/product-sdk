// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's deep-link navigation.
 *
 * `truApi.system.navigateTo` returns a neverthrow `ResultAsync`; consumers
 * still have to unwrap it themselves. {@link navigateTo} collapses that to a
 * `Result<void, HostError>`-returning Promise.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { type HostError, HostUnavailableError } from "./errors.js";
import { type Result, err } from "./result.js";
import { getTruApi, mapHostResult } from "./truapi.js";

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
 * @returns `ok` on success, or `err`: {@link HostUnavailableError} if the host
 *   is unavailable, or {@link HostCallFailedError} if it denies the navigation
 *   (`NavigateToErr::PermissionDenied`) or fails otherwise (`NavigateToErr::Unknown`).
 *
 * @example
 * ```ts
 * import { navigateTo } from "@parity/product-sdk-host";
 *
 * const r = await navigateTo("https://search.dot");
 * if (!r.ok) handle(r.error);
 * ```
 */
export async function navigateTo(url: string): Promise<Result<void, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("navigateTo: TruAPI unavailable"));
    }
    log.debug("navigateTo", { url });

    return mapHostResult(truApi.system.navigateTo({ url }), () => undefined, "navigateTo failed");
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
        test("returns err(HostUnavailableError) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.navigateTo("https://search.dot");
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.name).toBe("HostUnavailableError");
                }
            });
        });

        test("returns ok on success", async () => {
            await withMockedTruApi(
                {
                    system: {
                        navigateTo: vi.fn().mockReturnValue({
                            match: async (onOk: (v: unknown) => unknown) => onOk(undefined),
                        }),
                    },
                },
                async (mod) => {
                    expect(await mod.navigateTo("https://search.dot")).toEqual({
                        ok: true,
                        value: undefined,
                    });
                },
            );
        });

        test("wraps host errors in err(HostCallFailedError) with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    system: {
                        navigateTo: vi.fn().mockReturnValue({
                            match: async (
                                _onOk: (v: unknown) => unknown,
                                onErr: (e: unknown) => unknown,
                            ) =>
                                onErr({
                                    tag: "Domain",
                                    value: { tag: "V1", value: { tag: "PermissionDenied" } },
                                }),
                        }),
                    },
                },
                async (mod) => {
                    const result = await mod.navigateTo("https://search.dot");
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error.name).toBe("HostCallFailedError");
                        expect(result.error.message).toMatch(/navigateTo failed: PermissionDenied/);
                    }
                },
            );
        });
    });
}
