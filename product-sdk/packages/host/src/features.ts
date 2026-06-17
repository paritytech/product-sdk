// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrappers for the host's feature-support probe.
 *
 * `hostApi.featureSupported` is reachable via {@link getTruApi}, but consumers
 * have to wrap the feature in the versioned envelope (`enumValue("v1", ...)`)
 * and unwrap the neverthrow `ResultAsync` themselves. {@link featureSupported}
 * collapses that to a throw-on-error Promise; {@link isChainSupported} is a
 * convenience over the only feature variant the host exposes today (`Chain`).
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { enumValue, formatHostError, getTruApi, type HexString } from "./truapi.js";

const log = createLogger("host:features");

/**
 * A feature the host can be probed for via {@link featureSupported}.
 *
 * As of `host-api` v0.8 the only variant is `Chain`, carrying the chain's
 * `0x`-prefixed genesis hash. Modeled locally (rather than derived from an
 * upstream codec) because the protocol exposes the feature only inline; new
 * variants surface here as a widening of the union.
 */
export type Feature = { tag: "Chain"; value: HexString };

/**
 * Probe the host for support of a specific feature.
 *
 * Builds the `v1` envelope, calls `hostApi.featureSupported`, unwraps the
 * response, and returns the host's boolean answer.
 *
 * @param feature - The feature to probe for.
 * @returns `true` if the host supports the feature, `false` otherwise.
 * @throws If the host is unavailable or the probe fails (`GenericError`).
 *
 * @example
 * ```ts
 * import { featureSupported } from "@parity/product-sdk-host";
 *
 * const ok = await featureSupported({ tag: "Chain", value: genesisHash });
 * ```
 */
export async function featureSupported(feature: Feature): Promise<boolean> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("featureSupported: TruAPI unavailable");
    }
    log.debug("featureSupported", { tag: feature.tag });

    // `.match()` because the host returns a neverthrow ResultAsync, not a Promise.
    return await truApi.featureSupported(enumValue("v1", feature)).match(
        (envelope: { tag: "v1"; value: boolean }) => envelope.value,
        (err: unknown) => {
            throw new Error(`featureSupported failed: ${formatHostError(err)}`, { cause: err });
        },
    );
}

/**
 * Convenience probe: is the chain with the given genesis hash supported by the
 * host? Wraps {@link featureSupported} for the `Chain` feature variant.
 *
 * @param genesisHash - The chain's `0x`-prefixed genesis hash.
 * @returns `true` if the host supports the chain, `false` otherwise.
 * @throws If the host is unavailable or the probe fails.
 *
 * @example
 * ```ts
 * import { isChainSupported } from "@parity/product-sdk-host";
 *
 * if (!(await isChainSupported(genesisHash))) {
 *   tellUserChainUnavailable();
 * }
 * ```
 */
export async function isChainSupported(genesisHash: HexString): Promise<boolean> {
    return await featureSupported({ tag: "Chain", value: genesisHash });
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: { featureSupported?: (req: unknown) => unknown } | null,
        fn: (mod: typeof import("./features.js")) => Promise<T>,
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
            const mod = await import("./features.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    const okBridge = (value: boolean) => ({
        featureSupported: vi.fn().mockReturnValue({
            match: async (onOk: (v: unknown) => unknown) => onOk({ tag: "v1", value }),
        }),
    });

    describe("featureSupported", () => {
        test("throws when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                await expect(mod.featureSupported({ tag: "Chain", value: "0x00" })).rejects.toThrow(
                    /TruAPI unavailable/,
                );
            });
        });

        test("unwraps the v1 boolean outcome", async () => {
            await withMockedTruApi(okBridge(true), async (mod) => {
                expect(await mod.featureSupported({ tag: "Chain", value: "0x00" })).toBe(true);
            });
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    featureSupported: vi.fn().mockReturnValue({
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
                        mod.featureSupported({ tag: "Chain", value: "0x00" }),
                    ).rejects.toThrow(/featureSupported failed: GenericError: boom/);
                },
            );
        });
    });

    describe("isChainSupported", () => {
        test("delegates to featureSupported with the Chain variant", async () => {
            await withMockedTruApi(okBridge(false), async (mod) => {
                expect(await mod.isChainSupported("0x1234")).toBe(false);
            });
        });
    });
}
