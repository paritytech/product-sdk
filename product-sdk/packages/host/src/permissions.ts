// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrappers for the host's single-permission flows.
 *
 * `truApi.permissions.requestRemotePermission` / `requestDevicePermission`
 * return a neverthrow `ResultAsync` of a `{ granted }` response.
 * {@link requestPermission} and {@link requestDevicePermission} collapse that
 * to one-liners returning a `Result<boolean, HostError>` — the granted flag on
 * success, a typed {@link HostError} on the `err` channel.
 *
 * @module
 */

import type { HostDevicePermissionRequest } from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import { type HostError, HostUnavailableError } from "./errors.js";
import { type Result, err } from "./result.js";
import { getTruApi, mapHostResult, type RemotePermission } from "./truapi.js";

const log = createLogger("host:permissions");

/**
 * Device permission the dapp can ask the host to grant via
 * {@link requestDevicePermission}. A string union (`"Camera"`, `"Microphone"`,
 * …) re-exported from `@parity/truapi`.
 */
export type DevicePermissionKind = HostDevicePermissionRequest;

/**
 * Legacy alias of {@link RemotePermission}, kept for back-compat with code that
 * used the older name. Use either freely.
 */
export type RemotePermissionItem = RemotePermission;

/**
 * Request a single remote permission from the host.
 *
 * Calls `truApi.permissions.requestRemotePermission` and returns the host's
 * boolean granted/denied outcome.
 *
 * @param permission - The remote permission to request.
 * @returns `ok(true)` if the host granted the permission, `ok(false)` if denied,
 *   or `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * const r = await requestPermission({ tag: "ChainSubmit", value: undefined });
 * if (!r.ok || !r.value) {
 *   tellUserToReconnect();
 * }
 * ```
 */
export async function requestPermission(
    permission: RemotePermission,
): Promise<Result<boolean, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("requestPermission: TruAPI unavailable"));
    }
    log.debug("requestPermission", { tag: permission.tag });

    return mapHostResult(
        truApi.permissions.requestRemotePermission({ permission }),
        (response) => response.granted,
        "requestPermission failed",
    );
}

/**
 * Request a single device permission (camera, microphone, etc.) from the
 * host.
 *
 * Calls `truApi.permissions.requestDevicePermission` and returns the host's
 * boolean granted/denied outcome.
 *
 * @param permission - The device permission to request.
 * @returns `ok(true)` if the host granted the permission, `ok(false)` if denied,
 *   or `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * const r = await requestDevicePermission("Camera");
 * if (!r.ok || !r.value) {
 *   showCameraDeniedMessage();
 * }
 * ```
 */
export async function requestDevicePermission(
    permission: DevicePermissionKind,
): Promise<Result<boolean, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("requestDevicePermission: TruAPI unavailable"));
    }
    log.debug("requestDevicePermission", { permission });

    return mapHostResult(
        truApi.permissions.requestDevicePermission(permission),
        (response) => response.granted,
        "requestDevicePermission failed",
    );
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
        test("returns err(HostUnavailableError) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.requestPermission({
                    tag: "ChainSubmit",
                    value: undefined,
                });
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.name).toBe("HostUnavailableError");
                }
            });
        });

        test("returns ok with the granted flag", async () => {
            await withMockedTruApi(
                {
                    permissions: {
                        requestRemotePermission: vi.fn(() => okAsync({ granted: true })),
                    },
                },
                async (mod) => {
                    const result = await mod.requestPermission({
                        tag: "ChainSubmit",
                        value: undefined,
                    });
                    expect(result).toEqual({ ok: true, value: true });
                },
            );
        });

        test("wraps host errors in err(HostCallFailedError) with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    permissions: {
                        requestRemotePermission: vi.fn(() =>
                            errAsync({
                                tag: "Domain",
                                value: { tag: "V1", value: { reason: "boom" } },
                            }),
                        ),
                    },
                },
                async (mod) => {
                    const result = await mod.requestPermission({
                        tag: "ChainSubmit",
                        value: undefined,
                    });
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error.name).toBe("HostCallFailedError");
                        expect(result.error.message).toMatch(/requestPermission failed: boom/);
                    }
                },
            );
        });
    });

    describe("requestDevicePermission", () => {
        test("returns err(HostUnavailableError) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.requestDevicePermission("Camera");
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.name).toBe("HostUnavailableError");
                }
            });
        });

        test("returns ok with the granted flag", async () => {
            await withMockedTruApi(
                {
                    permissions: {
                        requestDevicePermission: vi.fn(() => okAsync({ granted: true })),
                    },
                },
                async (mod) => {
                    expect(await mod.requestDevicePermission("Camera")).toEqual({
                        ok: true,
                        value: true,
                    });
                },
            );
        });

        test("wraps host errors in err(HostCallFailedError) with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    permissions: {
                        requestDevicePermission: vi.fn(() =>
                            errAsync({
                                tag: "Domain",
                                value: { tag: "V1", value: { reason: "boom" } },
                            }),
                        ),
                    },
                },
                async (mod) => {
                    const result = await mod.requestDevicePermission("Camera");
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error.name).toBe("HostCallFailedError");
                        expect(result.error.message).toMatch(
                            /requestDevicePermission failed: boom/,
                        );
                    }
                },
            );
        });
    });
}
