/**
 * Higher-level wrappers for the host's permission and resource-allocation
 * flows.
 *
 * The underlying `hostApi.permission` and `hostApi.requestResourceAllocation`
 * methods take a versioned envelope (`enumValue("v1", ...)`) and return a
 * neverthrow `ResultAsync` of an unwrapped versioned response. Every dapp
 * that touches them ends up rebuilding the same wrap/unwrap dance and
 * casting the request `as never` because the host-api types lose precision
 * through the SDK's `UnwrapVersionedResult` plumbing.
 *
 * `requestProductPermissions` and `requestPermission` build the envelope,
 * unwrap the response, validate the version tag, and return a typed
 * `Result<T, string>`.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import type {
    AllocatableResource,
    AllocationOutcome,
    RemotePermission,
} from "./host-api-types.js";
import { enumValue, getTruApi, type ResultAsync } from "./truapi.js";

const log = createLogger("host:permissions");

/**
 * Lightweight tagged result returned by the permission wrappers.
 *
 * Mirrors the shape used by `@parity/product-sdk-signer`'s `Result` — the
 * host package can't depend on the signer package, so the alias is
 * duplicated here rather than introducing a shared types package.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Minimal subset of the host API surface used by the wrappers. Kept narrow
 * so we don't anchor on a specific `@novasamatech/host-api` version.
 */
interface PermissionBridge {
    requestResourceAllocation?: (request: unknown) => ResultAsync<unknown, unknown>;
    permission?: (request: unknown) => ResultAsync<unknown, unknown>;
}

type V1Method = keyof PermissionBridge;

/**
 * Request a batch of host resource allocations in a single round-trip.
 *
 * Builds the `v1` envelope, calls `hostApi.requestResourceAllocation`, and
 * unwraps the per-resource outcomes. Outcomes are positionally aligned with
 * the input — entry `i` is the outcome for resource `i`. A single rejected
 * entry doesn't fail the call; inspect each outcome's `tag` individually.
 *
 * @example
 * ```ts
 * const result = await requestProductPermissions([
 *   { tag: "SmartContractAllowance", value: 0 },
 *   { tag: "AutoSigning", value: undefined },
 * ]);
 * if (!result.ok) return notifyUser(result.error);
 * const [smartContract, autoSigning] = result.value;
 * if (smartContract.tag !== "Allocated") warn("contract allowance denied");
 * ```
 */
export async function requestProductPermissions(
    resources: AllocatableResource[],
): Promise<Result<AllocationOutcome[], string>> {
    return callV1<AllocationOutcome[]>("requestResourceAllocation", resources);
}

/**
 * Request a single remote permission from the host.
 *
 * Symmetric to {@link requestProductPermissions} but for
 * `hostApi.permission(...)`. Returns the host's boolean granted/denied
 * outcome, or a typed error.
 *
 * @example
 * ```ts
 * const result = await requestPermission({ tag: "ChainSubmit", value: undefined });
 * if (!result.ok) return warn(result.error);
 * if (!result.value) return tellUserToReconnect();
 * ```
 */
export async function requestPermission(
    permission: RemotePermission,
): Promise<Result<boolean, string>> {
    return callV1<boolean>("permission", permission);
}

async function callV1<T>(method: V1Method, payload: unknown): Promise<Result<T, string>> {
    const truApi = (await getTruApi()) as PermissionBridge | null;
    const fn = truApi?.[method];
    if (!fn) return { ok: false, error: "Host API unavailable" };

    try {
        const request = enumValue("v1", payload);
        return await fn.call(truApi, request).match(
            (response) => unwrapV1<T>(response),
            (error) => ({ ok: false, error: formatHostError(error) }) as const,
        );
    } catch (cause) {
        log.warn(`${method} threw`, { cause });
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
}

/**
 * Unwrap a versioned response envelope. The host today only ships `v1`, but
 * we don't hard-code that — a future version surfaces as a typed error
 * instead of silently dropping the response.
 */
function unwrapV1<T>(response: unknown): Result<T, string> {
    if (!response || typeof response !== "object" || !("tag" in response)) {
        return { ok: false, error: "Malformed host response (missing version tag)" };
    }
    const tagged = response as { tag: unknown; value: unknown };
    if (tagged.tag !== "v1") {
        return { ok: false, error: `Unrecognized host response version: ${String(tagged.tag)}` };
    }
    return { ok: true, value: tagged.value as T };
}

/**
 * Format a host-error for logging/display.
 *
 * host-api errors come back as `{ tag: "v1", value: <inner> }` where the
 * inner can be either another tagged enum (with its own tag/value) or a
 * plain `Error`-shaped object surfacing client-side codec failures
 * (e.g. `GenericError: inner[tag] is not a function` when the SDK
 * encodes a request the codec doesn't understand).
 *
 * Walking the value side as well as the tag means schema drift between
 * host-api versions and the SDK produces something more diagnostic than
 * just the outermost wrapper tag.
 */
export function formatHostError(error: unknown): string {
    if (!error || typeof error !== "object") return String(error);
    const e = error as Record<string, unknown>;
    if (!("tag" in e)) return String(error);

    const outerTag = String(e.tag);
    const inner = e.value;

    if (inner && typeof inner === "object") {
        const innerObj = inner as Record<string, unknown>;
        if (typeof innerObj.message === "string") {
            const innerName =
                typeof innerObj.name === "string" && innerObj.name !== "Error"
                    ? `${innerObj.name}: `
                    : "";
            return `${outerTag} → ${innerName}${innerObj.message}`;
        }
        if ("tag" in innerObj) {
            return `${outerTag} → ${formatHostError(inner)}`;
        }
    }

    if (inner !== undefined) {
        return `${outerTag} (${String(inner)})`;
    }
    return outerTag;
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    function fakeResultAsync<T>(value: T, error?: unknown): ResultAsync<T, unknown> {
        return {
            match: async (onOk, onErr) => {
                if (error !== undefined) return onErr(error);
                return onOk(value);
            },
        };
    }

    function fakeBridge(
        overrides: Partial<{
            requestResourceAllocation: PermissionBridge["requestResourceAllocation"];
            permission: PermissionBridge["permission"];
        }> = {},
    ): PermissionBridge {
        return overrides;
    }

    // Each test mocks the truapi module so getTruApi() resolves to the fake
    // bridge — bypasses the caching/dynamic-import path of the real loader.
    async function withMockedTruApi<T>(
        bridge: PermissionBridge | null,
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

    describe("requestProductPermissions", () => {
        test("returns Host API unavailable when truApi is null", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.requestProductPermissions([
                    { tag: "AutoSigning", value: undefined },
                ]);
                expect(result).toEqual({ ok: false, error: "Host API unavailable" });
            });
        });

        test("unwraps v1 outcomes positionally", async () => {
            const outcomes: AllocationOutcome[] = [
                { tag: "Allocated", value: undefined },
                { tag: "Rejected", value: undefined },
            ];
            await withMockedTruApi(
                fakeBridge({
                    requestResourceAllocation: vi
                        .fn()
                        .mockReturnValue(fakeResultAsync({ tag: "v1", value: outcomes })),
                }),
                async (mod) => {
                    const result = await mod.requestProductPermissions([
                        { tag: "SmartContractAllowance", value: 0 },
                        { tag: "AutoSigning", value: undefined },
                    ]);
                    expect(result).toEqual({ ok: true, value: outcomes });
                },
            );
        });

        test("returns typed error for unrecognized response version", async () => {
            await withMockedTruApi(
                fakeBridge({
                    requestResourceAllocation: vi
                        .fn()
                        .mockReturnValue(fakeResultAsync({ tag: "v2", value: [] })),
                }),
                async (mod) => {
                    const result = await mod.requestProductPermissions([
                        { tag: "AutoSigning", value: undefined },
                    ]);
                    expect(result).toEqual({
                        ok: false,
                        error: "Unrecognized host response version: v2",
                    });
                },
            );
        });

        test("surfaces a host rejection through formatHostError", async () => {
            await withMockedTruApi(
                fakeBridge({
                    requestResourceAllocation: vi
                        .fn()
                        .mockReturnValue(
                            fakeResultAsync(undefined, {
                                tag: "v1",
                                value: { name: "ResourceAllocationErr", message: "no quota" },
                            }),
                        ),
                }),
                async (mod) => {
                    const result = await mod.requestProductPermissions([
                        { tag: "AutoSigning", value: undefined },
                    ]);
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error).toContain("ResourceAllocationErr");
                        expect(result.error).toContain("no quota");
                    }
                },
            );
        });
    });

    describe("requestPermission", () => {
        test("returns Host API unavailable when truApi is null", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.requestPermission({
                    tag: "ChainSubmit",
                    value: undefined,
                });
                expect(result).toEqual({ ok: false, error: "Host API unavailable" });
            });
        });

        test("unwraps the v1 boolean outcome", async () => {
            await withMockedTruApi(
                fakeBridge({
                    permission: vi.fn().mockReturnValue(fakeResultAsync({ tag: "v1", value: true })),
                }),
                async (mod) => {
                    const result = await mod.requestPermission({
                        tag: "ChainSubmit",
                        value: undefined,
                    });
                    expect(result).toEqual({ ok: true, value: true });
                },
            );
        });
    });

    describe("formatHostError", () => {
        test("returns a string for a primitive error", () => {
            expect(formatHostError("Rejected")).toBe("Rejected");
            expect(formatHostError(42)).toBe("42");
            expect(formatHostError(null)).toBe("null");
            expect(formatHostError(undefined)).toBe("undefined");
        });

        test("surfaces inner Error name + message under the outer tag", () => {
            const wrapped = {
                tag: "v1",
                value: {
                    name: "GenericError",
                    message: "Unknown error: inner[tag] is not a function",
                },
            };
            const out = formatHostError(wrapped);
            expect(out).toContain("v1");
            expect(out).toContain("GenericError");
            expect(out).toContain("inner[tag] is not a function");
        });

        test("strips the redundant 'Error' name when the inner is a plain Error", () => {
            const wrapped = { tag: "v1", value: { name: "Error", message: "boom" } };
            expect(formatHostError(wrapped)).toBe("v1 → boom");
        });

        test("recurses through nested tagged-enum errors", () => {
            const wrapped = {
                tag: "v1",
                value: { tag: "Inner", value: { name: "NestedErr", message: "deep" } },
            };
            expect(formatHostError(wrapped)).toContain("v1");
            expect(formatHostError(wrapped)).toContain("Inner");
            expect(formatHostError(wrapped)).toContain("NestedErr");
            expect(formatHostError(wrapped)).toContain("deep");
        });

        test("returns just the outer tag when value is undefined", () => {
            expect(formatHostError({ tag: "PermissionDenied" })).toBe("PermissionDenied");
        });

        test("formats a primitive inner value alongside the tag", () => {
            expect(formatHostError({ tag: "v1", value: "code-42" })).toBe("v1 (code-42)");
        });
    });
}
