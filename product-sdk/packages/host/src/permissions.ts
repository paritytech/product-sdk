/**
 * Higher-level wrapper for the host's single-permission flow.
 *
 * `hostApi.permission` takes a versioned envelope (`enumValue("v1", ...)`)
 * and returns a neverthrow `ResultAsync` of an unwrapped versioned response.
 * Consumers rebuild that wrap/unwrap dance every time. `requestPermission`
 * collapses it to a one-liner that matches the shape of
 * {@link requestResourceAllocation} (throws on error, returns the unwrapped
 * payload on success).
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { enumValue, getTruApi, type RemotePermission } from "./truapi.js";

const log = createLogger("host:permissions");

/**
 * Request a single remote permission from the host.
 *
 * Builds the `v1` envelope, calls `hostApi.permission`, unwraps the response,
 * and returns the host's boolean granted/denied outcome.
 *
 * @param permission - The remote permission to request.
 * @returns `true` if the host granted the permission, `false` if denied.
 * @throws If the host is unavailable or the request fails.
 *
 * @example
 * ```ts
 * const granted = await requestPermission({ tag: "ChainSubmit", value: undefined });
 * if (!granted) {
 *   tellUserToReconnect();
 * }
 * ```
 */
export async function requestPermission(permission: RemotePermission): Promise<boolean> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("requestPermission: TruAPI unavailable");
    }
    log.debug("requestPermission", { tag: permission.tag });

    return await truApi.permission(enumValue("v1", permission)).match(
        (envelope: { tag: "v1"; value: boolean }) => envelope.value,
        (err: unknown) => {
            throw new Error(
                `requestPermission failed: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
            );
        },
    );
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: { permission?: (req: unknown) => unknown } | null,
        fn: (mod: typeof import("./permissions.js")) => Promise<T>,
    ): Promise<T> {
        vi.resetModules();
        vi.doMock("./truapi.js", () => ({
            getTruApi: async () => bridge,
            enumValue: (version: string, value: unknown) => ({ tag: version, value }),
        }));
        try {
            const mod = await import("./permissions.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    describe("requestPermission", () => {
        test("throws when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                await expect(
                    mod.requestPermission({ tag: "ChainSubmit", value: undefined }),
                ).rejects.toThrow(/TruAPI unavailable/);
            });
        });

        test("unwraps the v1 boolean outcome", async () => {
            await withMockedTruApi(
                {
                    permission: vi.fn().mockReturnValue({
                        match: async (onOk: (v: unknown) => unknown) =>
                            onOk({ tag: "v1", value: true }),
                    }),
                },
                async (mod) => {
                    const granted = await mod.requestPermission({
                        tag: "ChainSubmit",
                        value: undefined,
                    });
                    expect(granted).toBe(true);
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    permission: vi.fn().mockReturnValue({
                        match: async (
                            _onOk: (v: unknown) => unknown,
                            onErr: (e: unknown) => unknown,
                        ) =>
                            onErr({
                                tag: "v1",
                                value: { name: "GenericError", message: "boom" },
                            }),
                    }),
                },
                async (mod) => {
                    await expect(
                        mod.requestPermission({ tag: "ChainSubmit", value: undefined }),
                    ).rejects.toThrow(/requestPermission failed/);
                },
            );
        });
    });
}
