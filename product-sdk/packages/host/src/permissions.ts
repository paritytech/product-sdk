/**
 * Higher-level wrappers for the host's single-permission flows.
 *
 * `hostApi.permission` / `hostApi.devicePermission` take a versioned
 * envelope (`enumValue("v1", ...)`) and return a neverthrow `ResultAsync`
 * of an unwrapped versioned response. Consumers rebuild that wrap/unwrap
 * dance every time. {@link requestPermission} and
 * {@link requestDevicePermission} collapse it to one-liners that match the
 * shape of {@link requestResourceAllocation} (throws on error, returns
 * the unwrapped payload on success).
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import type { CodecType } from "@novasamatech/host-api";
import type { DevicePermission as DevicePermissionCodec } from "@novasamatech/host-api";

import { enumValue, formatHostError, getTruApi, type RemotePermission } from "./truapi.js";

const log = createLogger("host:permissions");

/**
 * Device permission the dapp can ask the host to grant via
 * {@link requestDevicePermission}.
 *
 * Derived from the upstream codec so variant renames surface as compile
 * errors, not runtime failures.
 */
export type DevicePermissionKind = CodecType<typeof DevicePermissionCodec>;

/**
 * Alias of {@link RemotePermission} matching the upstream
 * `@novasamatech/host-api-wrapper` name. Use either freely.
 */
export type RemotePermissionItem = RemotePermission;

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
            throw new Error(`requestPermission failed: ${formatHostError(err)}`, { cause: err });
        },
    );
}

/**
 * Request a single device permission (camera, microphone, etc.) from the
 * host.
 *
 * Builds the `v1` envelope, calls `hostApi.devicePermission`, unwraps the
 * response, and returns the host's boolean granted/denied outcome.
 *
 * @param permission - The device permission to request.
 * @returns `true` if the host granted the permission, `false` if denied.
 * @throws If the host is unavailable or the request fails.
 *
 * @example
 * ```ts
 * const granted = await requestDevicePermission("Camera");
 * if (!granted) {
 *   showCameraDeniedMessage();
 * }
 * ```
 */
export async function requestDevicePermission(permission: DevicePermissionKind): Promise<boolean> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("requestDevicePermission: TruAPI unavailable");
    }
    log.debug("requestDevicePermission", { permission });

    return await truApi.devicePermission(enumValue("v1", permission)).match(
        (envelope: { tag: "v1"; value: boolean }) => envelope.value,
        (err: unknown) => {
            throw new Error(`requestDevicePermission failed: ${formatHostError(err)}`, {
                cause: err,
            });
        },
    );
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: {
            permission?: (req: unknown) => unknown;
            devicePermission?: (req: unknown) => unknown;
        } | null,
        fn: (mod: typeof import("./permissions.js")) => Promise<T>,
    ): Promise<T> {
        vi.resetModules();
        vi.doMock("./truapi.js", async (importOriginal) => {
            const original = await importOriginal<typeof import("./truapi.js")>();
            return {
                ...original,
                getTruApi: async () => bridge,
                enumValue: (version: string, value: unknown) => ({ tag: version, value }),
            };
        });
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
                    ).rejects.toThrow(/requestPermission failed: GenericError: boom/);
                },
            );
        });
    });

    describe("requestDevicePermission", () => {
        test("throws when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                await expect(mod.requestDevicePermission("Camera")).rejects.toThrow(
                    /TruAPI unavailable/,
                );
            });
        });

        test("unwraps the v1 boolean outcome", async () => {
            await withMockedTruApi(
                {
                    devicePermission: vi.fn().mockReturnValue({
                        match: async (onOk: (v: unknown) => unknown) =>
                            onOk({ tag: "v1", value: true }),
                    }),
                },
                async (mod) => {
                    const granted = await mod.requestDevicePermission("Camera");
                    expect(granted).toBe(true);
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    devicePermission: vi.fn().mockReturnValue({
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
                    await expect(mod.requestDevicePermission("Camera")).rejects.toThrow(
                        /requestDevicePermission failed: GenericError: boom/,
                    );
                },
            );
        });
    });
}
