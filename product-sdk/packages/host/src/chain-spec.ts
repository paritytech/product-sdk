// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's chain-spec lookups.
 *
 * The host exposes three separate chain-spec calls — `chain.getSpecGenesisHash`,
 * `chain.getSpecChainName`, and `chain.getSpecProperties` — each reachable via
 * {@link getTruApi} and each returning a neverthrow `ResultAsync`.
 * {@link getChainSpec} fetches all three in one call and returns a single
 * struct so callers read whichever field they need, matching the JSON-RPC
 * `chainSpec_v1_*` family they mirror.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import type { HostError } from "./errors.js";
import { type Result, ok } from "./result.js";
import { getTruApi, type HexString, mapHostResult } from "./truapi.js";

const log = createLogger("host:chain-spec");

/**
 * Chain SS58/token properties as reported by the host's
 * `chainSpecProperties` call.
 *
 * The host returns this as a JSON string (mirroring the substrate
 * `chainSpec_v1_properties` JSON-RPC, whose payload is an open-ended object).
 * {@link getChainSpec} parses it into {@link properties} and also surfaces the
 * untouched JSON as {@link propertiesRaw}. The well-known substrate fields are
 * typed for convenience; the index signature keeps any chain-specific extras
 * reachable without `any` at the call site.
 */
export interface ChainProperties {
    /** Address prefix used for SS58 encoding (e.g. `0` for Polkadot). */
    ss58Format?: number;
    /** Decimal places of the chain's native token(s). */
    tokenDecimals?: number | number[];
    /** Ticker symbol(s) of the chain's native token(s). */
    tokenSymbol?: string | string[];
    /** Chain-specific extras passed through verbatim from the JSON payload. */
    [key: string]: unknown;
}

/**
 * Combined chain-spec view returned by {@link getChainSpec}.
 */
export interface ChainSpec {
    /** The chain's `0x`-prefixed genesis hash, as reported by the host. */
    genesisHash: HexString;
    /** Human-readable chain name (e.g. `"Polkadot"`). */
    name: string;
    /**
     * Parsed chain properties, or `null` if the host's JSON payload couldn't
     * be parsed. Inspect {@link propertiesRaw} for the original string.
     */
    properties: ChainProperties | null;
    /** The untouched JSON string the host returned for properties. */
    propertiesRaw: string;
}

/**
 * Fetch a chain's full spec (genesis hash, name, and properties) from the host
 * in one call.
 *
 * Issues the three underlying `chain.getSpec*` requests concurrently, unwraps
 * each response, and parses the properties JSON. Note the `genesisHash` in the
 * result is the value the host echoes back from `getSpecGenesisHash` for the
 * looked-up chain — pass the chain's known genesis hash as the lookup key.
 *
 * `null` (outside a container) is preserved as an `ok` value — it is an
 * expected state, not a failure — so callers branch on `r.ok && r.value`. A
 * real host-call failure surfaces on the `err` channel.
 *
 * @param genesisHash - The `0x`-prefixed genesis hash identifying the chain.
 * @returns `ok(spec)` with the combined {@link ChainSpec}, `ok(null)` if the
 *   host is unavailable (running outside a container), or
 *   `err(HostCallFailedError)` if any underlying host call fails.
 *
 * @example
 * ```ts
 * import { getChainSpec } from "@parity/product-sdk-host";
 *
 * const r = await getChainSpec(genesisHash);
 * if (r.ok && r.value) {
 *   console.log(r.value.name, r.value.properties?.tokenSymbol);
 * }
 * ```
 */
export async function getChainSpec(
    genesisHash: HexString,
): Promise<Result<ChainSpec | null, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        log.debug("getChainSpec: TruAPI unavailable");
        return ok(null);
    }
    log.debug("getChainSpec", { genesisHash });

    const [genesisHashResult, nameResult, propertiesResult] = await Promise.all([
        mapHostResult(
            truApi.chain.getSpecGenesisHash({ genesisHash }),
            (response) => response.genesisHash,
            "getChainSpec (genesisHash) failed",
        ),
        mapHostResult(
            truApi.chain.getSpecChainName({ genesisHash }),
            (response) => response.chainName,
            "getChainSpec (chainName) failed",
        ),
        mapHostResult(
            truApi.chain.getSpecProperties({ genesisHash }),
            (response) => response.properties,
            "getChainSpec (properties) failed",
        ),
    ]);

    // Short-circuit on the first failing call.
    if (!genesisHashResult.ok) return genesisHashResult;
    if (!nameResult.ok) return nameResult;
    if (!propertiesResult.ok) return propertiesResult;

    const propertiesRaw = propertiesResult.value;
    let properties: ChainProperties | null;
    try {
        properties = JSON.parse(propertiesRaw) as ChainProperties;
    } catch (parseError) {
        log.debug("getChainSpec: properties JSON parse failed", parseError);
        properties = null;
    }

    return ok({
        genesisHash: genesisHashResult.value,
        name: nameResult.value,
        properties,
        propertiesRaw,
    });
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: {
            chain?: {
                getSpecGenesisHash?: (req: unknown) => unknown;
                getSpecChainName?: (req: unknown) => unknown;
                getSpecProperties?: (req: unknown) => unknown;
            };
        } | null,
        fn: (mod: typeof import("./chain-spec.js")) => Promise<T>,
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
            const mod = await import("./chain-spec.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    /** A resolved ResultAsync stub yielding the given response object. */
    const okAsync = (response: unknown) => ({
        match: async (onOk: (v: unknown) => unknown) => onOk(response),
    });

    describe("getChainSpec", () => {
        test("returns ok(null) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                expect(await mod.getChainSpec("0x00")).toEqual({ ok: true, value: null });
            });
        });

        test("combines the three calls and parses properties JSON", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        getSpecGenesisHash: vi
                            .fn()
                            .mockReturnValue(okAsync({ genesisHash: "0xabcd" })),
                        getSpecChainName: vi
                            .fn()
                            .mockReturnValue(okAsync({ chainName: "Polkadot" })),
                        getSpecProperties: vi.fn().mockReturnValue(
                            okAsync({
                                properties:
                                    '{"ss58Format":0,"tokenDecimals":10,"tokenSymbol":"DOT"}',
                            }),
                        ),
                    },
                },
                async (mod) => {
                    const result = await mod.getChainSpec("0xabcd");
                    expect(result).toEqual({
                        ok: true,
                        value: {
                            genesisHash: "0xabcd",
                            name: "Polkadot",
                            properties: { ss58Format: 0, tokenDecimals: 10, tokenSymbol: "DOT" },
                            propertiesRaw:
                                '{"ss58Format":0,"tokenDecimals":10,"tokenSymbol":"DOT"}',
                        },
                    });
                },
            );
        });

        test("leaves properties null when the JSON is malformed", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        getSpecGenesisHash: vi
                            .fn()
                            .mockReturnValue(okAsync({ genesisHash: "0xabcd" })),
                        getSpecChainName: vi
                            .fn()
                            .mockReturnValue(okAsync({ chainName: "Polkadot" })),
                        getSpecProperties: vi
                            .fn()
                            .mockReturnValue(okAsync({ properties: "not json" })),
                    },
                },
                async (mod) => {
                    const result = await mod.getChainSpec("0xabcd");
                    expect(result.ok).toBe(true);
                    if (result.ok) {
                        expect(result.value?.properties).toBeNull();
                        expect(result.value?.propertiesRaw).toBe("not json");
                    }
                },
            );
        });

        test("returns err(HostCallFailedError) when a host call fails", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        getSpecGenesisHash: vi.fn().mockReturnValue({
                            match: async (
                                _onOk: (v: unknown) => unknown,
                                onErr: (e: unknown) => unknown,
                            ) => onErr({ reason: "boom" }),
                        }),
                        getSpecChainName: vi
                            .fn()
                            .mockReturnValue(okAsync({ chainName: "Polkadot" })),
                        getSpecProperties: vi.fn().mockReturnValue(okAsync({ properties: "{}" })),
                    },
                },
                async (mod) => {
                    const result = await mod.getChainSpec("0xabcd");
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error.name).toBe("HostCallFailedError");
                        expect(result.error.message).toMatch(
                            /getChainSpec \(genesisHash\) failed: boom/,
                        );
                    }
                },
            );
        });
    });
}
