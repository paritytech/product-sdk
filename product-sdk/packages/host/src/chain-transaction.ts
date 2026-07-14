// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrappers for the host's transaction broadcast lifecycle.
 *
 * `truApi.chain.broadcastTransaction` / `truApi.chain.stopTransaction` are
 * reachable via {@link getTruApi}, but consumers have to unwrap the neverthrow
 * `ResultAsync` themselves. {@link broadcastTransaction} and
 * {@link stopTransaction} collapse that to `Result`-returning Promises, mirroring
 * the JSON-RPC `transaction_v1_broadcast` / `transaction_v1_stop` pair they
 * wrap.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { type HostError, HostUnavailableError } from "./errors.js";
import { type Result, err } from "./result.js";
import { getTruApi, type HexString, mapHostResult } from "./truapi.js";

const log = createLogger("host:chain-transaction");

/**
 * Broadcast a signed transaction to the network via the host.
 *
 * Calls `truApi.chain.broadcastTransaction` and unwraps the response. The host
 * keeps re-broadcasting until the transaction is finalized/dropped or
 * {@link stopTransaction} is called with the returned operation id.
 *
 * @param genesisHash - The `0x`-prefixed genesis hash of the target chain.
 * @param transaction - The `0x`-prefixed SCALE-encoded signed transaction.
 * @returns `ok` with the operation id to pass to {@link stopTransaction} (or
 *   `null` if the host accepted the broadcast without issuing one), or
 *   `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * import { broadcastTransaction, stopTransaction } from "@parity/product-sdk-host";
 *
 * const r = await broadcastTransaction(genesisHash, signedTx);
 * // later, to stop re-broadcasting:
 * if (r.ok && r.value) await stopTransaction(genesisHash, r.value);
 * ```
 */
export async function broadcastTransaction(
    genesisHash: HexString,
    transaction: HexString,
): Promise<Result<string | null, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("broadcastTransaction: TruAPI unavailable"));
    }
    log.debug("broadcastTransaction", { genesisHash });

    return mapHostResult(
        truApi.chain.broadcastTransaction({ genesisHash, transaction }),
        (response) => response.operationId ?? null,
        "broadcastTransaction failed",
    );
}

/**
 * Stop an in-flight broadcast started by {@link broadcastTransaction}.
 *
 * Calls `truApi.chain.stopTransaction` and unwraps the response.
 *
 * @param genesisHash - The `0x`-prefixed genesis hash of the target chain.
 * @param operationId - The operation id returned by
 *   {@link broadcastTransaction}.
 * @returns `ok` on success, or `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * await stopTransaction(genesisHash, operationId);
 * ```
 */
export async function stopTransaction(
    genesisHash: HexString,
    operationId: string,
): Promise<Result<void, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("stopTransaction: TruAPI unavailable"));
    }
    log.debug("stopTransaction", { genesisHash, operationId });

    return mapHostResult(
        truApi.chain.stopTransaction({ genesisHash, operationId }),
        () => undefined,
        "stopTransaction failed",
    );
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: {
            chain?: {
                broadcastTransaction?: (req: unknown) => unknown;
                stopTransaction?: (req: unknown) => unknown;
            };
        } | null,
        fn: (mod: typeof import("./chain-transaction.js")) => Promise<T>,
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
            const mod = await import("./chain-transaction.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    /** A resolved ResultAsync stub yielding the given response object. */
    const ok = (response: unknown) => ({
        match: async (onOk: (v: unknown) => unknown) => onOk(response),
    });
    /** A rejected ResultAsync stub yielding a truapi `GenericError` (`{ reason }`). */
    const errResult = (reason: string) => ({
        match: async (_onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
            onErr({ reason }),
    });

    describe("broadcastTransaction", () => {
        test("returns err(HostUnavailableError) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.broadcastTransaction("0x00", "0x01");
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.name).toBe("HostUnavailableError");
                }
            });
        });

        test("returns ok with the operation id", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        broadcastTransaction: vi.fn().mockReturnValue(ok({ operationId: "op-1" })),
                    },
                },
                async (mod) => {
                    expect(await mod.broadcastTransaction("0x00", "0x01")).toEqual({
                        ok: true,
                        value: "op-1",
                    });
                },
            );
        });

        test("passes through a missing operation id as ok(null)", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        broadcastTransaction: vi.fn().mockReturnValue(ok({})),
                    },
                },
                async (mod) => {
                    expect(await mod.broadcastTransaction("0x00", "0x01")).toEqual({
                        ok: true,
                        value: null,
                    });
                },
            );
        });

        test("wraps host errors in err(HostCallFailedError) with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        broadcastTransaction: vi.fn().mockReturnValue(errResult("boom")),
                    },
                },
                async (mod) => {
                    const result = await mod.broadcastTransaction("0x00", "0x01");
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error.name).toBe("HostCallFailedError");
                        expect(result.error.message).toMatch(/broadcastTransaction failed: boom/);
                    }
                },
            );
        });
    });

    describe("stopTransaction", () => {
        test("returns err(HostUnavailableError) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.stopTransaction("0x00", "op-1");
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.name).toBe("HostUnavailableError");
                }
            });
        });

        test("returns ok on success", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        stopTransaction: vi.fn().mockReturnValue(ok(undefined)),
                    },
                },
                async (mod) => {
                    expect(await mod.stopTransaction("0x00", "op-1")).toEqual({
                        ok: true,
                        value: undefined,
                    });
                },
            );
        });

        test("wraps host errors in err(HostCallFailedError) with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        stopTransaction: vi.fn().mockReturnValue(errResult("boom")),
                    },
                },
                async (mod) => {
                    const result = await mod.stopTransaction("0x00", "op-1");
                    expect(result.ok).toBe(false);
                    if (!result.ok) {
                        expect(result.error.name).toBe("HostCallFailedError");
                        expect(result.error.message).toMatch(/stopTransaction failed: boom/);
                    }
                },
            );
        });
    });
}
