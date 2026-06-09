// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createLogger } from "@parity/product-sdk-logger";
import { submitAndWatch, type TxStatus, type WaitFor } from "@parity/product-sdk-tx";
import type { PolkadotSigner } from "polkadot-api";
import { Enum } from "polkadot-api";

import { CloudStorageAuthorizationError, ProductCloudStorageError } from "./errors.js";
import type { AuthorizationStatus, CloudStorageApi } from "./types.js";

const log = createLogger("cloudStorage");

const NOT_AUTHORIZED: AuthorizationStatus = Object.freeze({
    authorized: false,
    remainingTransactions: 0,
    remainingBytes: 0n,
    expiration: 0,
});

/**
 * Check whether an account is authorized to store data in Cloud Storage.
 *
 * Queries `TransactionStorage.Authorizations` for the given address and returns
 * the raw authorization quota. Use this as a pre-flight check before calling
 * {@link CloudStorageClient.store} to provide clear UX ("not authorized" / "insufficient quota")
 * instead of letting the transaction fail mid-execution.
 *
 * The expiration block number is returned as-is — the chain enforces expiration
 * at submission time, so callers can optionally compare against the current
 * block for display purposes.
 *
 * @param api     - Typed Cloud Storage API instance.
 * @param address - SS58-encoded account address to check.
 * @returns Authorization status with remaining quota.
 *
 * @example
 * ```ts
 * import { checkAuthorization } from "@parity/product-sdk-cloud-storage";
 *
 * const auth = await checkAuthorization(api, address);
 * if (!auth.authorized) {
 *     console.error("Account is not authorized for cloud storage");
 * } else if (auth.remainingBytes < BigInt(fileBytes.length)) {
 *     console.error(`Insufficient quota: ${auth.remainingBytes} bytes remaining`);
 * }
 * ```
 *
 * @see {@link CloudStorageClient.checkAuthorization} for the client method equivalent.
 */
export async function checkAuthorization(
    api: CloudStorageApi,
    address: string,
): Promise<AuthorizationStatus> {
    let auth;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        auth = await (api as any).query.TransactionStorage.Authorizations.getValue(
            Enum("Account", address),
        );
    } catch (error) {
        // No log here — the thrown CloudStorageAuthorizationError carries the
        // address and underlying error as `cause`. Logging before throwing
        // would double-report transient failures (e.g. DisjointError) for
        // callers that handle the throw (`.catch(() => null)`), spamming
        // stderr they have no way to suppress.
        throw new CloudStorageAuthorizationError(address, error);
    }

    if (!auth) {
        log.debug("checkAuthorization: no authorization found", { address });
        return NOT_AUTHORIZED;
    }

    // After polkadot-bulletin-chain PR #448 (e543696, 2026-04-30), AuthorizationExtent's
    // `transactions` and `bytes` fields are *consumed counters*; the granted allowance moved
    // to `transactions_allowance` / `bytes_allowance`. Compute remaining = allowance − consumed
    // so the public `remainingTransactions` / `remainingBytes` contract stays semantically
    // honest.
    const status: AuthorizationStatus = {
        authorized: true,
        remainingTransactions: auth.extent.transactions_allowance - auth.extent.transactions,
        // `auth` is `any` (TypedApi<any> upstream — see line 53). TS narrows
        // `any - any` to `number`, so cast each u64 operand to bigint to keep
        // the subtraction in bigint space. Runtime values are bigints from PAPI.
        remainingBytes: (auth.extent.bytes_allowance as bigint) - (auth.extent.bytes as bigint),
        expiration: auth.expiration,
    };

    log.debug("checkAuthorization", {
        address,
        remainingTransactions: status.remainingTransactions,
        remainingBytes: status.remainingBytes.toString(),
        expiration: status.expiration,
    });

    return status;
}

/**
 * Options for {@link authorizeAccount}.
 */
export interface AuthorizeAccountOptions {
    /**
     * Wrap the extrinsic in `Sudo.sudo(...)` before submission. Default: `false`.
     *
     * Use `true` on networks where granting cloud storage authorization
     * requires sudo permissions (most production / managed test networks).
     * Use `false` (default) when the account self-authorizes — typical for
     * local development chains.
     */
    viaSudo?: boolean;
    /** When to resolve: `"best-block"` (default) or `"finalized"`. */
    waitFor?: WaitFor;
    /** Timeout in ms. Default: 300_000 (5 min). */
    timeoutMs?: number;
    /** Lifecycle status callback for UI progress. */
    onStatus?: (status: TxStatus) => void;
}

/**
 * Grant an account authorization to store data in Cloud Storage.
 *
 * Submits a `TransactionStorage.authorize_account` extrinsic, optionally
 * wrapped in `Sudo.sudo(...)` for networks that require sudo to grant
 * authorization. Mirrors the call shape of {@link CloudStorageClient.store} — top-level
 * function, takes an explicit signer, returns a block hash on success.
 *
 * Pair with {@link checkAuthorization} for a typical "check, grant if
 * insufficient, then upload" flow.
 *
 * ## Additive semantics — call once per authorization need
 *
 * `authorize_account` is **additive** within an unexpired authorization window
 * for `AuthorizationScope::Account` (see `pallet-bulletin-transaction-storage`,
 * `fn authorize`). Each successful call **adds** to the existing
 * `transactions_allowance` and `bytes_allowance` rather than overwriting them.
 *
 * Implications for callers:
 *
 * - Calling this function twice with `(100, 1MB)` while the previous
 *   authorization is still active leaves the account with quota for `200`
 *   transactions and `2MB` — likely unintended.
 * - **This function does NOT use `withRetry`.** Retrying a successful-but-
 *   acknowledgment-lost submission would double-grant the quota. Callers
 *   needing retry should wrap this function and use {@link checkAuthorization}
 *   to verify the post-state before retrying.
 * - To "reset" a quota, let the existing authorization expire
 *   (`AuthorizationPeriod` blocks). The next call after expiry creates a fresh
 *   authorization rather than adding.
 *
 * Note: `AuthorizationScope::Preimage` uses `set` semantics in the same
 * pallet. This helper is for account-scope authorization only.
 *
 * @param api          - Typed Cloud Storage API instance.
 * @param who          - SS58-encoded account to authorize.
 * @param transactions - Number of transactions to **add** to the account's allowance.
 * @param bytes        - Byte budget to **add** to the account's allowance.
 * @param signer       - Signer for the extrinsic. On `viaSudo: true` this must be the sudo key.
 * @param options      - Optional `viaSudo` flag plus standard submission controls.
 * @returns Block hash where the extrinsic was included.
 * @throws {ProductCloudStorageError} If `viaSudo: true` is requested but the chain has no `Sudo` pallet.
 *
 * @example Direct (account self-authorizes — local dev)
 * ```ts
 * import { authorizeAccount } from "@parity/product-sdk-cloud-storage";
 *
 * await authorizeAccount(api, address, 100, 100n * 1024n * 1024n, signer);
 * ```
 *
 * @example Sudo-wrapped (managed test network)
 * ```ts
 * await authorizeAccount(api, userAddress, 100, 1_000_000n, sudoSigner, {
 *     viaSudo: true,
 * });
 * ```
 *
 * @see {@link checkAuthorization} for the read counterpart.
 * @see {@link CloudStorageClient.authorizeAccount} for the client method equivalent.
 */
export async function authorizeAccount(
    api: CloudStorageApi,
    who: string,
    transactions: number,
    bytes: bigint,
    signer: PolkadotSigner,
    options: AuthorizeAccountOptions = {},
): Promise<{ blockHash: string }> {
    const { viaSudo = false, waitFor, timeoutMs, onStatus } = options;

    // Single `as any` cast for the whole function. `CloudStorageApi` is upstream-
    // typed as `TypedApi<any>` (see types.ts), so member access is loose by
    // design. Same pattern as upload.ts:57 — narrowing it requires retyping
    // CloudStorageApi against a bundled descriptor (out of scope here).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiTx = (api as any).tx;

    log.info("authorizeAccount: building extrinsic", {
        who,
        transactions,
        bytes: bytes.toString(),
        viaSudo,
    });

    if (viaSudo && !apiTx.Sudo?.sudo) {
        throw new ProductCloudStorageError(
            "viaSudo: true requires the Sudo pallet, which is not available on this network. " +
                "On production networks (Polkadot, Kusama), authorize_account requires governance or a different mechanism.",
        );
    }

    const authorizeTx = apiTx.TransactionStorage.authorize_account({
        who,
        transactions,
        bytes,
    });

    const txToSubmit = viaSudo ? apiTx.Sudo.sudo({ call: authorizeTx.decodedCall }) : authorizeTx;

    // NOTE: Intentionally NOT using `withRetry` here. `authorize_account` is
    // additive (see JSDoc above), so a retry after a successful-but-lost
    // submission would double-grant the quota. Caller-side retry must verify
    // post-state via `checkAuthorization` first.
    const result = await submitAndWatch(txToSubmit, signer, {
        waitFor,
        timeoutMs,
        onStatus,
    });

    log.info("authorizeAccount: included in block", {
        who,
        blockHash: result.block.hash,
    });

    return { blockHash: result.block.hash };
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    function createMockApi(authResult: unknown) {
        return {
            query: {
                TransactionStorage: {
                    Authorizations: {
                        getValue: vi.fn().mockResolvedValue(authResult),
                    },
                },
            },
        } as unknown as CloudStorageApi;
    }

    describe("checkAuthorization", () => {
        test("returns not authorized when no authorization exists", async () => {
            const api = createMockApi(undefined);
            const status = await checkAuthorization(api, "5GrwvaEF...");

            expect(status.authorized).toBe(false);
            expect(status.remainingTransactions).toBe(0);
            expect(status.remainingBytes).toBe(0n);
            expect(status.expiration).toBe(0);
        });

        test("returns authorization with full quota (fresh authorize, nothing consumed)", async () => {
            const api = createMockApi({
                extent: {
                    transactions: 0,
                    transactions_allowance: 10,
                    bytes: 0n,
                    bytes_permanent: 0n,
                    bytes_allowance: 1_000_000n,
                },
                expiration: 999,
            });
            const status = await checkAuthorization(api, "5GrwvaEF...");

            expect(status.authorized).toBe(true);
            expect(status.remainingTransactions).toBe(10);
            expect(status.remainingBytes).toBe(1_000_000n);
            expect(status.expiration).toBe(999);
        });

        test("returns authorization with zero transactions remaining (fully consumed)", async () => {
            const api = createMockApi({
                extent: {
                    transactions: 5,
                    transactions_allowance: 5,
                    bytes: 0n,
                    bytes_permanent: 0n,
                    bytes_allowance: 1_000_000n,
                },
                expiration: 999,
            });
            const status = await checkAuthorization(api, "5GrwvaEF...");

            expect(status.authorized).toBe(true);
            expect(status.remainingTransactions).toBe(0);
        });

        test("returns authorization with zero bytes remaining (fully consumed)", async () => {
            const api = createMockApi({
                extent: {
                    transactions: 0,
                    transactions_allowance: 5,
                    bytes: 1_000n,
                    bytes_permanent: 0n,
                    bytes_allowance: 1_000n,
                },
                expiration: 999,
            });
            const status = await checkAuthorization(api, "5GrwvaEF...");

            expect(status.authorized).toBe(true);
            expect(status.remainingBytes).toBe(0n);
        });

        test("returns remaining = allowance − consumed when partially used", async () => {
            const api = createMockApi({
                extent: {
                    transactions: 3,
                    transactions_allowance: 10,
                    bytes: 250_000n,
                    bytes_permanent: 0n,
                    bytes_allowance: 1_000_000n,
                },
                expiration: 999,
            });
            const status = await checkAuthorization(api, "5GrwvaEF...");

            expect(status.authorized).toBe(true);
            expect(status.remainingTransactions).toBe(7); // 10 − 3
            expect(status.remainingBytes).toBe(750_000n); // 1M − 250K
        });

        test("preserves expiration block number", async () => {
            const api = createMockApi({
                extent: {
                    transactions: 0,
                    transactions_allowance: 1,
                    bytes: 0n,
                    bytes_permanent: 0n,
                    bytes_allowance: 500n,
                },
                expiration: 12345,
            });
            const status = await checkAuthorization(api, "5GrwvaEF...");

            expect(status.expiration).toBe(12345);
        });

        test("throws CloudStorageAuthorizationError when query fails", async () => {
            const api = {
                query: {
                    TransactionStorage: {
                        Authorizations: {
                            getValue: vi.fn().mockRejectedValue(new Error("RPC connection lost")),
                        },
                    },
                },
            } as unknown as CloudStorageApi;

            const err = await checkAuthorization(api, "5GrwvaEF...").catch((e: unknown) => e);
            expect(err).toBeInstanceOf(CloudStorageAuthorizationError);
            const error = err as CloudStorageAuthorizationError;
            expect(error.address).toBe("5GrwvaEF...");
            expect(error.cause).toBeInstanceOf(Error);
            expect((error.cause as Error).message).toBe("RPC connection lost");
        });

        test("does NOT emit any error-level log when the query fails (caller owns the throw)", async () => {
            // Regression guard for the "double-report" UX bug: pre-fix,
            // checkAuthorization logged at error level *before* throwing,
            // so a caller catching the throw (e.g. `.catch(() => null)`)
            // still got a scary stderr line they had no way to suppress.
            // The throw carries the address + cause already; let the caller
            // decide whether to log.
            const { configure } = await import("@parity/product-sdk-logger");
            type LogEntry = { level: string; namespace: string; message: string };
            const entries: LogEntry[] = [];
            configure({
                level: "debug",
                handler: (e) => entries.push(e as LogEntry),
            });

            const api = {
                query: {
                    TransactionStorage: {
                        Authorizations: {
                            getValue: vi.fn().mockRejectedValue(new Error("DisjointError")),
                        },
                    },
                },
            } as unknown as CloudStorageApi;

            await checkAuthorization(api, "5GrwvaEF...").catch(() => null);

            const errorLogs = entries.filter(
                (e) => e.namespace === "cloudStorage" && e.level === "error",
            );
            expect(errorLogs).toEqual([]);
        });

        test("passes correct Enum key to the query", async () => {
            const getValue = vi.fn().mockResolvedValue(undefined);
            const api = {
                query: {
                    TransactionStorage: {
                        Authorizations: { getValue },
                    },
                },
            } as unknown as CloudStorageApi;

            await checkAuthorization(api, "5GrwvaEF...");

            expect(getValue).toHaveBeenCalledTimes(1);
            const arg = getValue.mock.calls[0][0];
            expect(arg.type).toBe("Account");
            expect(arg.value).toBe("5GrwvaEF...");
        });
    });

    /**
     * Mock factory for `authorizeAccount` tests.
     *
     * Mirrors the mocking style used in `upload.ts` — we don't mock
     * `submitAndWatch` (the SDK helper) directly. Instead we let it call
     * through to a fake `signSubmitAndWatch` on the api, which emits the
     * lifecycle events `submitAndWatch` listens for.
     */
    function createMockApiForAuthorize(blockHash = "0xblockhash") {
        const fakeTx = {
            decodedCall: { fakeCall: true } as unknown,
            signSubmitAndWatch: vi.fn().mockReturnValue({
                subscribe: (handlers: { next: (e: unknown) => void }) => {
                    queueMicrotask(() => {
                        handlers.next({ type: "signed", txHash: "0xtxhash" });
                        handlers.next({
                            type: "txBestBlocksState",
                            txHash: "0xtxhash",
                            found: true,
                            ok: true,
                            block: { hash: blockHash, number: 1, index: 0 },
                            events: [],
                        });
                    });
                    return { unsubscribe: vi.fn() };
                },
            }),
        };

        return {
            api: {
                tx: {
                    TransactionStorage: {
                        authorize_account: vi.fn().mockReturnValue(fakeTx),
                    },
                    Sudo: {
                        sudo: vi.fn().mockReturnValue(fakeTx),
                    },
                },
            },
            fakeTx,
        };
    }

    const mockSigner = {} as PolkadotSigner;

    describe("authorizeAccount", () => {
        test("direct path: calls TransactionStorage.authorize_account with the right params", async () => {
            const { api } = createMockApiForAuthorize();

            await authorizeAccount(
                api as unknown as CloudStorageApi,
                "5GrwvaEF...",
                100,
                1_000_000n,
                mockSigner,
            );

            expect(api.tx.TransactionStorage.authorize_account).toHaveBeenCalledOnce();
            const arg = api.tx.TransactionStorage.authorize_account.mock.calls[0][0];
            expect(arg.who).toBe("5GrwvaEF...");
            expect(arg.transactions).toBe(100);
            expect(arg.bytes).toBe(1_000_000n);
        });

        test("direct path: does NOT call Sudo.sudo when viaSudo is false (default)", async () => {
            const { api } = createMockApiForAuthorize();

            await authorizeAccount(
                api as unknown as CloudStorageApi,
                "5GrwvaEF...",
                10,
                100n,
                mockSigner,
            );

            expect(api.tx.Sudo.sudo).not.toHaveBeenCalled();
        });

        test("direct path: returns the block hash from submission", async () => {
            const { api } = createMockApiForAuthorize("0xdeadbeef");

            const result = await authorizeAccount(
                api as unknown as CloudStorageApi,
                "5GrwvaEF...",
                10,
                100n,
                mockSigner,
            );

            expect(result).toEqual({ blockHash: "0xdeadbeef" });
        });

        test("sudo path: wraps the authorize_account call inside Sudo.sudo", async () => {
            const { api, fakeTx } = createMockApiForAuthorize();

            await authorizeAccount(
                api as unknown as CloudStorageApi,
                "5GrwvaEF...",
                10,
                100n,
                mockSigner,
                { viaSudo: true },
            );

            expect(api.tx.Sudo.sudo).toHaveBeenCalledOnce();
            const sudoArg = api.tx.Sudo.sudo.mock.calls[0][0];
            expect(sudoArg.call).toBe(fakeTx.decodedCall);
        });

        test("sudo path: still returns the block hash from the sudo extrinsic", async () => {
            const { api } = createMockApiForAuthorize("0xsudoblock");

            const result = await authorizeAccount(
                api as unknown as CloudStorageApi,
                "5GrwvaEF...",
                10,
                100n,
                mockSigner,
                { viaSudo: true },
            );

            expect(result).toEqual({ blockHash: "0xsudoblock" });
        });

        test("throws ProductCloudStorageError when viaSudo is true but the chain lacks a Sudo pallet", async () => {
            const apiWithoutSudo = {
                tx: {
                    TransactionStorage: {
                        authorize_account: vi.fn().mockReturnValue({
                            decodedCall: {} as unknown,
                            signSubmitAndWatch: vi.fn(),
                        }),
                    },
                    // Sudo intentionally absent — represents production Polkadot/Kusama
                },
            };

            const err = await authorizeAccount(
                apiWithoutSudo as unknown as CloudStorageApi,
                "5GrwvaEF...",
                10,
                100n,
                mockSigner,
                { viaSudo: true },
            ).catch((e: unknown) => e);

            expect(err).toBeInstanceOf(ProductCloudStorageError);
            expect((err as Error).message).toMatch(/Sudo pallet/i);
            // Verify we did NOT proceed to submit anything
            expect(apiWithoutSudo.tx.TransactionStorage.authorize_account).not.toHaveBeenCalled();
        });

        // Note: submission-failure propagation is tested upstream in
        // @parity/product-sdk-tx's own suite. Re-testing it here would just
        // re-test submitAndWatch's error path through a brittle mock, which
        // depends on internal event-shape details outside this file's contract.
    });
}
