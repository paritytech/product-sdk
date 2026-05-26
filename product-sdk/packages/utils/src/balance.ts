// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Balance breakdown from a Substrate `System.Account` query. */
export interface AccountBalance {
    /** Available (transferable) balance in planck. */
    free: bigint;
    /** Reserved (locked by governance, staking, etc.) balance in planck. */
    reserved: bigint;
    /** Frozen (non-transferable but still counted) balance in planck. */
    frozen: bigint;
}

/**
 * Minimal structural type for a PAPI typed API with `System.Account`.
 *
 * Structural so it works with any chain that has the System pallet, without
 * importing chain-specific descriptors.
 */
export interface BalanceApi {
    query: {
        System: {
            Account: {
                getValue(
                    address: string,
                ): Promise<{ data: { free: bigint; reserved: bigint; frozen: bigint } }>;
            };
        };
    };
}

/**
 * Query the free, reserved, and frozen balances for an on-chain address.
 *
 * Thin typed wrapper around `System.Account.getValue` that returns a clean
 * {@link AccountBalance} object. Uses structural typing so it works with any
 * PAPI typed API that has the System pallet — no chain-specific imports needed.
 *
 * @param api - A PAPI typed API with `query.System.Account`. Pass the chain-specific
 *   API (e.g., `client.assetHub`), not the multi-chain `ChainClient` wrapper.
 * @param address - The SS58 address to query.
 * @returns The account's balance breakdown.
 *
 * @example
 * ```ts
 * import { getBalance } from "@parity/product-sdk-utils";
 * import { formatBalance } from "@parity/product-sdk-utils";
 *
 * const balance = await getBalance(api.assetHub, aliceAddress);
 * console.log(formatBalance(balance.free, { symbol: "DOT" })); // "1,000.5 DOT"
 * ```
 */
export async function getBalance(api: BalanceApi, address: string): Promise<AccountBalance> {
    const account = await api.query.System.Account.getValue(address);
    return {
        free: account.data.free,
        reserved: account.data.reserved,
        frozen: account.data.frozen,
    };
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    function createMockApi(data: {
        free: bigint;
        reserved: bigint;
        frozen: bigint;
    }): BalanceApi {
        return {
            query: {
                System: {
                    Account: {
                        getValue: async () => ({ data }),
                    },
                },
            },
        };
    }

    describe("getBalance", () => {
        test("returns correct AccountBalance from API", async () => {
            const api = createMockApi({
                free: 10_000_000_000n,
                reserved: 5_000_000_000n,
                frozen: 1_000_000_000n,
            });

            const balance = await getBalance(
                api,
                "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            );

            expect(balance.free).toBe(10_000_000_000n);
            expect(balance.reserved).toBe(5_000_000_000n);
            expect(balance.frozen).toBe(1_000_000_000n);
        });

        test("propagates errors from getValue", async () => {
            const api: BalanceApi = {
                query: {
                    System: {
                        Account: {
                            getValue: async () => {
                                throw new Error("RPC connection failed");
                            },
                        },
                    },
                },
            };

            await expect(getBalance(api, "5GrwvaEF...")).rejects.toThrow("RPC connection failed");
        });

        test("works with zero balances", async () => {
            const api = createMockApi({ free: 0n, reserved: 0n, frozen: 0n });

            const balance = await getBalance(api, "5GrwvaEF...");

            expect(balance.free).toBe(0n);
            expect(balance.reserved).toBe(0n);
            expect(balance.frozen).toBe(0n);
        });
    });
}
