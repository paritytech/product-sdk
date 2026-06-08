// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrappers for the host's single-permission flows.
 *
 * `truApi.permissions.requestRemotePermission` / `requestDevicePermission`
 * return a neverthrow `ResultAsync` of a `{ granted }` response.
 * {@link requestPermission} and {@link requestDevicePermission} collapse that
 * to one-liners that match the shape of {@link requestResourceAllocation}
 * (throws on error, returns the unwrapped boolean on success).
 *
 * @module
 */

import type { HostDevicePermissionRequest } from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import { getTruApi, type RemotePermission, unwrapHostResult } from "./truapi.js";

const log = createLogger("host:permissions");

/**
 * Device permission the dapp can ask the host to grant via
 * {@link requestDevicePermission}. A string union (`"Camera"`, `"Microphone"`,
 * …) re-exported from `@parity/truapi`.
 */
export type DevicePermissionKind = HostDevicePermissionRequest;

/**
 * Alias of {@link RemotePermission} matching the upstream
 * `host-api-wrapper` name. Use either freely.
 */
export type RemotePermissionItem = RemotePermission;

/**
 * Request a single remote permission from the host.
 *
 * Calls `truApi.permissions.requestRemotePermission` and returns the host's
 * boolean granted/denied outcome.
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

    const response = await unwrapHostResult(
        truApi.permissions.requestRemotePermission({ permission }),
        "requestPermission failed",
    );
    return response.granted;
}

/**
 * Request a single device permission (camera, microphone, etc.) from the
 * host.
 *
 * Calls `truApi.permissions.requestDevicePermission` and returns the host's
 * boolean granted/denied outcome.
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

    const response = await unwrapHostResult(
        truApi.permissions.requestDevicePermission(permission),
        "requestDevicePermission failed",
    );
    return response.granted;
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    function okAsync<T>(value: T) {
        return { match: async (onOk: (v: T) => unknown) => onOk(value) };
    }
    function errAsync<E>(error: E) {
        return {
            match: async (_onOk: (v: unknown) => unknown, onErr: (e: E) => unknown) => onErr(error),
        };
    }

    async function withMockedTruApi<T>(
        client: unknown,
        fn: (mod: typeof import("./permissions.js")) => Promise<T>,
    ): Promise<T> {
        vi.resetModules();
        vi.doMock("./truapi.js", async (importOriginal) => {
            const original = await importOriginal<typeof import("./truapi.js")>();
            return { ...original, getTruApi: async () => client };
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

        test("returns the granted flag", async () => {
            await withMockedTruApi(
                {
                    permissions: {
                        requestRemotePermission: vi.fn(() => okAsync({ granted: true })),
                    },
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
                    permissions: {
                        requestRemotePermission: vi.fn(() => errAsync({ reason: "boom" })),
                    },
                },
                async (mod) => {
                    await expect(
                        mod.requestPermission({ tag: "ChainSubmit", value: undefined }),
                    ).rejects.toThrow(/requestPermission failed: boom/);
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

        test("returns the granted flag", async () => {
            await withMockedTruApi(
                {
                    permissions: {
                        requestDevicePermission: vi.fn(() => okAsync({ granted: true })),
                    },
                },
                async (mod) => {
                    expect(await mod.requestDevicePermission("Camera")).toBe(true);
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    permissions: {
                        requestDevicePermission: vi.fn(() => errAsync({ reason: "boom" })),
                    },
                },
                async (mod) => {
                    await expect(mod.requestDevicePermission("Camera")).rejects.toThrow(
                        /requestDevicePermission failed: boom/,
                    );
                },
            );
        });
    });
}
