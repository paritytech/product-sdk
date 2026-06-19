// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrappers for the host's transaction broadcast lifecycle.
 *
 * `truApi.chain.broadcastTransaction` / `truApi.chain.stopTransaction` are
 * reachable via {@link getTruApi}, but consumers have to unwrap the neverthrow
 * `ResultAsync` themselves. {@link broadcastTransaction} and
 * {@link stopTransaction} collapse that to throw-on-error Promises, mirroring
 * the JSON-RPC `transaction_v1_broadcast` / `transaction_v1_stop` pair they
 * wrap.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { formatHostError, getTruApi, type HexString } from "./truapi.js";

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
 * @returns The operation id to pass to {@link stopTransaction}, or `null` if
 *   the host accepted the broadcast without issuing one.
 * @throws If the host is unavailable or the broadcast fails (`GenericError`).
 *
 * @example
 * ```ts
 * import { broadcastTransaction, stopTransaction } from "@parity/product-sdk-host";
 *
 * const operationId = await broadcastTransaction(genesisHash, signedTx);
 * // later, to stop re-broadcasting:
 * if (operationId) await stopTransaction(genesisHash, operationId);
 * ```
 */
export async function broadcastTransaction(
    genesisHash: HexString,
    transaction: HexString,
): Promise<string | null> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("broadcastTransaction: TruAPI unavailable");
    }
    log.debug("broadcastTransaction", { genesisHash });

    // `.match()` because the host returns a neverthrow ResultAsync, not a Promise.
    return await truApi.chain.broadcastTransaction({ genesisHash, transaction }).match(
        (response) => response.operationId ?? null,
        (err: unknown) => {
            throw new Error(`broadcastTransaction failed: ${formatHostError(err)}`, {
                cause: err,
            });
        },
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
 * @throws If the host is unavailable or the stop fails (`GenericError`).
 *
 * @example
 * ```ts
 * await stopTransaction(genesisHash, operationId);
 * ```
 */
export async function stopTransaction(genesisHash: HexString, operationId: string): Promise<void> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("stopTransaction: TruAPI unavailable");
    }
    log.debug("stopTransaction", { genesisHash, operationId });

    // `.match()` because the host returns a neverthrow ResultAsync, not a Promise.
    await truApi.chain.stopTransaction({ genesisHash, operationId }).match(
        () => undefined,
        (err: unknown) => {
            throw new Error(`stopTransaction failed: ${formatHostError(err)}`, { cause: err });
        },
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
        test("throws when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                await expect(mod.broadcastTransaction("0x00", "0x01")).rejects.toThrow(
                    /TruAPI unavailable/,
                );
            });
        });

        test("unwraps the operation id", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        broadcastTransaction: vi.fn().mockReturnValue(ok({ operationId: "op-1" })),
                    },
                },
                async (mod) => {
                    expect(await mod.broadcastTransaction("0x00", "0x01")).toBe("op-1");
                },
            );
        });

        test("passes through a missing operation id as null", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        broadcastTransaction: vi.fn().mockReturnValue(ok({})),
                    },
                },
                async (mod) => {
                    expect(await mod.broadcastTransaction("0x00", "0x01")).toBeNull();
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        broadcastTransaction: vi.fn().mockReturnValue(errResult("boom")),
                    },
                },
                async (mod) => {
                    await expect(mod.broadcastTransaction("0x00", "0x01")).rejects.toThrow(
                        /broadcastTransaction failed: boom/,
                    );
                },
            );
        });
    });

    describe("stopTransaction", () => {
        test("throws when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                await expect(mod.stopTransaction("0x00", "op-1")).rejects.toThrow(
                    /TruAPI unavailable/,
                );
            });
        });

        test("resolves on success", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        stopTransaction: vi.fn().mockReturnValue(ok(undefined)),
                    },
                },
                async (mod) => {
                    await expect(mod.stopTransaction("0x00", "op-1")).resolves.toBeUndefined();
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    chain: {
                        stopTransaction: vi.fn().mockReturnValue(errResult("boom")),
                    },
                },
                async (mod) => {
                    await expect(mod.stopTransaction("0x00", "op-1")).rejects.toThrow(
                        /stopTransaction failed: boom/,
                    );
                },
            );
        });
    });
}
