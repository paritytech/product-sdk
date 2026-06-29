// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrappers for the host's feature-support probe.
 *
 * `truApi.system.featureSupported` returns a neverthrow `ResultAsync`;
 * {@link featureSupported} collapses that to a `Result` carrying the host's
 * boolean answer. {@link isChainSupported} is a convenience over the only
 * feature variant the host exposes today (`Chain`).
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { type HostError, HostUnavailableError } from "./errors.js";
import { type Result, err } from "./result.js";
import { getTruApi, type HexString, mapHostResult } from "./truapi.js";

const log = createLogger("host:features");

/**
 * A feature the host can be probed for via {@link featureSupported}.
 *
 * The only variant today is `Chain`, carrying the chain's `0x`-prefixed genesis
 * hash. This is a flattened form of truapi's `HostFeatureSupportedRequest`,
 * which nests the hash as `{ tag: "Chain"; value: { genesisHash } }` — we
 * inline `value` as the `HexString` for ergonomics and re-nest it at the call
 * site. New variants surface here as a widening of the union.
 */
export type Feature = { tag: "Chain"; value: HexString };

/**
 * Probe the host for support of a specific feature.
 *
 * Calls `truApi.system.featureSupported`, unwraps the response, and returns the
 * host's boolean answer.
 *
 * @param feature - The feature to probe for.
 * @returns `ok(true)` if the host supports the feature, `ok(false)` otherwise,
 *   or `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * import { featureSupported } from "@parity/product-sdk-host";
 *
 * const r = await featureSupported({ tag: "Chain", value: genesisHash });
 * if (r.ok && r.value) { ... }
 * ```
 */
export async function featureSupported(feature: Feature): Promise<Result<boolean, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("featureSupported: TruAPI unavailable"));
    }
    log.debug("featureSupported", { tag: feature.tag });

    return mapHostResult(
        truApi.system.featureSupported({ tag: feature.tag, value: { genesisHash: feature.value } }),
        (response) => response.supported,
        "featureSupported failed",
    );
}

/**
 * Convenience probe: is the chain with the given genesis hash supported by the
 * host? Wraps {@link featureSupported} for the `Chain` feature variant.
 *
 * @param genesisHash - The chain's `0x`-prefixed genesis hash.
 * @returns `ok(true)` if the host supports the chain, `ok(false)` otherwise, or
 *   `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * import { isChainSupported } from "@parity/product-sdk-host";
 *
 * const r = await isChainSupported(genesisHash);
 * if (!r.ok || !r.value) {
 *   tellUserChainUnavailable();
 * }
 * ```
 */
export async function isChainSupported(
    genesisHash: HexString,
): Promise<Result<boolean, HostError>> {
    return featureSupported({ tag: "Chain", value: genesisHash });
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: { system?: { featureSupported?: (req: unknown) => unknown } } | null,
        fn: (mod: typeof import("./features.js")) => Promise<T>,
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
            const mod = await import("./features.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    const okBridge = (supported: boolean) => ({
        system: {
            featureSupported: vi.fn().mockReturnValue({
                match: async (onOk: (v: unknown) => unknown) => onOk({ supported }),
            }),
        },
    });

    describe("featureSupported", () => {
        test("returns err(HostUnavailableError) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.featureSupported({ tag: "Chain", value: "0x00" });
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.name).toBe("HostUnavailableError");
                }
            });
        });

        test("returns ok with the boolean outcome", async () => {
            await withMockedTruApi(okBridge(true), async (mod) => {
                expect(await mod.featureSupported({ tag: "Chain", value: "0x00" })).toEqual({
                    ok: true,
                    value: true,
                });
            });
        });

        test("wraps host errors in err(HostCallFailedError) with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    system: {
                        featureSupported: vi.fn().mockReturnValue({
                            match: async (
                                _onOk: (v: unknown) => unknown,
                                onErr: (e: unknown) => unknown,
                            ) => onErr({ reason: "boom" }),
                        }),
                    },
                },
                async (mod) => {
                    const result = await mod.featureSupported({ tag: "Chain", value: "0x00" });
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error.name).toBe("HostCallFailedError");
                        expect(result.error.message).toMatch(/featureSupported failed: boom/);
                    }
                },
            );
        });
    });

    describe("isChainSupported", () => {
        test("delegates to featureSupported with the Chain variant", async () => {
            await withMockedTruApi(okBridge(false), async (mod) => {
                expect(await mod.isChainSupported("0x1234")).toEqual({ ok: true, value: false });
            });
        });
    });
}
