// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrappers for the host's transaction broadcast lifecycle.
 *
 * `hostApi.chainTransactionBroadcast` / `hostApi.chainTransactionStop` are
 * reachable via {@link getTruApi}, but consumers have to build the versioned
 * envelope (`enumValue("v1", ...)`) and unwrap the neverthrow `ResultAsync`
 * themselves. {@link broadcastTransaction} and {@link stopTransaction}
 * collapse that to throw-on-error Promises, mirroring the JSON-RPC
 * `transaction_v1_broadcast` / `transaction_v1_stop` pair they wrap.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { enumValue, formatHostError, getTruApi, type HexString } from "./truapi.js";

const log = createLogger("host:chain-transaction");

/**
 * Broadcast a signed transaction to the network via the host.
 *
 * Builds the `v1` envelope, calls `hostApi.chainTransactionBroadcast`, and
 * unwraps the response. The host keeps re-broadcasting until the transaction
 * is finalized/dropped or {@link stopTransaction} is called with the returned
 * operation id.
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
    return await truApi
        .chainTransactionBroadcast(enumValue("v1", { genesisHash, transaction }))
        .match(
            (envelope: { tag: "v1"; value: string | null }) => envelope.value,
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
 * Builds the `v1` envelope, calls `hostApi.chainTransactionStop`, and unwraps
 * the response.
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
    await truApi.chainTransactionStop(enumValue("v1", { genesisHash, operationId })).match(
        (_envelope: { tag: "v1"; value: undefined }) => undefined,
        (err: unknown) => {
            throw new Error(`stopTransaction failed: ${formatHostError(err)}`, { cause: err });
        },
    );
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    async function withMockedTruApi<T>(
        bridge: {
            chainTransactionBroadcast?: (req: unknown) => unknown;
            chainTransactionStop?: (req: unknown) => unknown;
        } | null,
        fn: (mod: typeof import("./chain-transaction.js")) => Promise<T>,
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
            const mod = await import("./chain-transaction.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    const ok = (value: unknown) => ({
        match: async (onOk: (v: unknown) => unknown) => onOk({ tag: "v1", value }),
    });
    const errResult = (name: string, message: string) => ({
        match: async (_onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
            onErr({ tag: "v1", value: { name, message } }),
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
                { chainTransactionBroadcast: vi.fn().mockReturnValue(ok("op-1")) },
                async (mod) => {
                    expect(await mod.broadcastTransaction("0x00", "0x01")).toBe("op-1");
                },
            );
        });

        test("passes through a null operation id", async () => {
            await withMockedTruApi(
                { chainTransactionBroadcast: vi.fn().mockReturnValue(ok(null)) },
                async (mod) => {
                    expect(await mod.broadcastTransaction("0x00", "0x01")).toBeNull();
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    chainTransactionBroadcast: vi
                        .fn()
                        .mockReturnValue(errResult("GenericError", "boom")),
                },
                async (mod) => {
                    await expect(mod.broadcastTransaction("0x00", "0x01")).rejects.toThrow(
                        /broadcastTransaction failed: GenericError: boom/,
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

        test("resolves on the v1 success envelope", async () => {
            await withMockedTruApi(
                { chainTransactionStop: vi.fn().mockReturnValue(ok(undefined)) },
                async (mod) => {
                    await expect(mod.stopTransaction("0x00", "op-1")).resolves.toBeUndefined();
                },
            );
        });

        test("wraps host errors with a diagnostic message", async () => {
            await withMockedTruApi(
                {
                    chainTransactionStop: vi
                        .fn()
                        .mockReturnValue(errResult("GenericError", "boom")),
                },
                async (mod) => {
                    await expect(mod.stopTransaction("0x00", "op-1")).rejects.toThrow(
                        /stopTransaction failed: GenericError: boom/,
                    );
                },
            );
        });
    });
}
