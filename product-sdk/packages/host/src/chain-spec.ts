// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's chain-spec lookups.
 *
 * The host exposes three separate chain-spec calls — `chainSpecGenesisHash`,
 * `chainSpecChainName`, and `chainSpecProperties` — each reachable via
 * {@link getTruApi} but each requiring its own `enumValue("v1", ...)` wrap
 * and neverthrow `ResultAsync` unwrap. {@link getChainSpec} fetches all three
 * in one call and returns a single struct so callers read whichever field
 * they need, matching the JSON-RPC `chainSpec_v1_*` family they mirror.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { enumValue, formatHostError, getTruApi, type HexString } from "./truapi.js";

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
 * Issues the three underlying `chainSpec*` requests concurrently, unwraps each
 * `v1` envelope, and parses the properties JSON. Note the `genesisHash` in the
 * result is the value the host echoes back from `chainSpecGenesisHash` for the
 * looked-up chain — pass the chain's known genesis hash as the lookup key.
 *
 * @param genesisHash - The `0x`-prefixed genesis hash identifying the chain.
 * @returns The combined {@link ChainSpec}, or `null` if the host is
 *   unavailable (running outside a container).
 * @throws If any of the underlying host calls fail (`GenericError`).
 *
 * @example
 * ```ts
 * import { getChainSpec } from "@parity/product-sdk-host";
 *
 * const spec = await getChainSpec(genesisHash);
 * if (spec) {
 *   console.log(spec.name, spec.properties?.tokenSymbol);
 * }
 * ```
 */
export async function getChainSpec(genesisHash: HexString): Promise<ChainSpec | null> {
    const truApi = await getTruApi();
    if (!truApi) {
        log.debug("getChainSpec: TruAPI unavailable");
        return null;
    }
    log.debug("getChainSpec", { genesisHash });

    // `.match()` because the host returns neverthrow ResultAsync values, not Promises.
    const [resolvedGenesisHash, name, propertiesRaw] = await Promise.all([
        truApi.chainSpecGenesisHash(enumValue("v1", genesisHash)).match(
            (envelope: { tag: "v1"; value: HexString }) => envelope.value,
            (err: unknown) => {
                throw new Error(`getChainSpec (genesisHash) failed: ${formatHostError(err)}`, {
                    cause: err,
                });
            },
        ),
        truApi.chainSpecChainName(enumValue("v1", genesisHash)).match(
            (envelope: { tag: "v1"; value: string }) => envelope.value,
            (err: unknown) => {
                throw new Error(`getChainSpec (chainName) failed: ${formatHostError(err)}`, {
                    cause: err,
                });
            },
        ),
        truApi.chainSpecProperties(enumValue("v1", genesisHash)).match(
            (envelope: { tag: "v1"; value: string }) => envelope.value,
            (err: unknown) => {
                throw new Error(`getChainSpec (properties) failed: ${formatHostError(err)}`, {
                    cause: err,
                });
            },
        ),
    ]);

    let properties: ChainProperties | null;
    try {
        properties = JSON.parse(propertiesRaw) as ChainProperties;
    } catch (err) {
        log.debug("getChainSpec: properties JSON parse failed", err);
        properties = null;
    }

    return { genesisHash: resolvedGenesisHash, name, properties, propertiesRaw };
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: {
            chainSpecGenesisHash?: (req: unknown) => unknown;
            chainSpecChainName?: (req: unknown) => unknown;
            chainSpecProperties?: (req: unknown) => unknown;
        } | null,
        fn: (mod: typeof import("./chain-spec.js")) => Promise<T>,
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
            const mod = await import("./chain-spec.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    const ok = (value: unknown) => ({
        match: async (onOk: (v: unknown) => unknown) => onOk({ tag: "v1", value }),
    });

    describe("getChainSpec", () => {
        test("returns null when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                expect(await mod.getChainSpec("0x00")).toBeNull();
            });
        });

        test("combines the three calls and parses properties JSON", async () => {
            await withMockedTruApi(
                {
                    chainSpecGenesisHash: vi.fn().mockReturnValue(ok("0xabcd")),
                    chainSpecChainName: vi.fn().mockReturnValue(ok("Polkadot")),
                    chainSpecProperties: vi
                        .fn()
                        .mockReturnValue(
                            ok('{"ss58Format":0,"tokenDecimals":10,"tokenSymbol":"DOT"}'),
                        ),
                },
                async (mod) => {
                    const spec = await mod.getChainSpec("0xabcd");
                    expect(spec).toEqual({
                        genesisHash: "0xabcd",
                        name: "Polkadot",
                        properties: { ss58Format: 0, tokenDecimals: 10, tokenSymbol: "DOT" },
                        propertiesRaw: '{"ss58Format":0,"tokenDecimals":10,"tokenSymbol":"DOT"}',
                    });
                },
            );
        });

        test("leaves properties null when the JSON is malformed", async () => {
            await withMockedTruApi(
                {
                    chainSpecGenesisHash: vi.fn().mockReturnValue(ok("0xabcd")),
                    chainSpecChainName: vi.fn().mockReturnValue(ok("Polkadot")),
                    chainSpecProperties: vi.fn().mockReturnValue(ok("not json")),
                },
                async (mod) => {
                    const spec = await mod.getChainSpec("0xabcd");
                    expect(spec?.properties).toBeNull();
                    expect(spec?.propertiesRaw).toBe("not json");
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    chainSpecGenesisHash: vi.fn().mockReturnValue({
                        match: async (
                            _onOk: (v: unknown) => unknown,
                            onErr: (e: unknown) => unknown,
                        ) => onErr({ tag: "v1", value: { name: "GenericError", message: "boom" } }),
                    }),
                    chainSpecChainName: vi.fn().mockReturnValue(ok("Polkadot")),
                    chainSpecProperties: vi.fn().mockReturnValue(ok("{}")),
                },
                async (mod) => {
                    await expect(mod.getChainSpec("0xabcd")).rejects.toThrow(
                        /getChainSpec \(genesisHash\) failed: GenericError: boom/,
                    );
                },
            );
        });
    });
}
