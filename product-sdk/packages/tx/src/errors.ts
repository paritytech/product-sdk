// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Base class for all transaction errors. Use `instanceof TxError` to catch any tx-related error. */
export class TxError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "TxError";
    }
}

/** The transaction did not finalize within the configured timeout. It may still be processing on-chain. */
export class TxTimeoutError extends TxError {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(
            `Transaction timed out after ${timeoutMs / 1000}s. The transaction may still be processing on-chain.`,
        );
        this.name = "TxTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

/** The transaction was included on-chain but the dispatch failed. */
export class TxDispatchError extends TxError {
    /** Raw dispatch error from polkadot-api. */
    readonly dispatchError: unknown;
    /** Human-readable error string (e.g., "Revive.ContractReverted"). */
    readonly formatted: string;

    constructor(dispatchError: unknown, formatted: string) {
        super(`Transaction dispatch failed: ${formatted}`);
        this.name = "TxDispatchError";
        this.dispatchError = dispatchError;
        this.formatted = formatted;
    }
}

/** The user rejected the signing request in their wallet. */
export class TxSigningRejectedError extends TxError {
    constructor() {
        super("Transaction signing was rejected.");
        this.name = "TxSigningRejectedError";
    }
}

/**
 * Extract a human-readable error from a transaction result's dispatch error.
 *
 * PAPI dispatch errors for pallet modules are nested:
 *   `{ type: "Module", value: { type: "Revive", value: { type: "ContractReverted" } } }`
 *
 * This walks the chain to build a string like `"Revive.ContractReverted"`.
 *
 * @param result - A transaction result with `ok` and optional `dispatchError`.
 * @returns A human-readable error string, or `""` if the result is ok, or `"unknown error"` if
 *   the dispatch error cannot be decoded.
 */
export function formatDispatchError(result: { ok: boolean; dispatchError?: unknown }): string {
    if (result.ok) return "";

    try {
        const err = result.dispatchError as { type?: string; value?: unknown } | undefined;
        if (!err) return "unknown error";

        if (err.type === "Module" && err.value && typeof err.value === "object") {
            const palletErr = err.value as { type?: string; value?: unknown };
            const palletName = palletErr.type ?? "Unknown";

            if (palletErr.value && typeof palletErr.value === "object") {
                const innerErr = palletErr.value as { type?: string };
                if (innerErr.type) {
                    return `${palletName}.${innerErr.type}`;
                }
            }
            return palletName;
        }

        return err.type ?? "unknown error";
    } catch {
        return "unknown error";
    }
}

/** Error specific to batch transaction construction (e.g., empty calls array). */
export class TxBatchError extends TxError {
    constructor(message: string) {
        super(message);
        this.name = "TxBatchError";
    }
}

/**
 * A dry-run simulation failed before the transaction was submitted on-chain.
 *
 * Thrown by {@link extractTransaction} when the dry-run result indicates failure.
 * Carries structured error information so callers can distinguish revert reasons
 * from dispatch errors programmatically.
 *
 * @example
 * ```ts
 * try {
 *   const tx = extractTransaction(await contract.query("mint", { origin, data }));
 * } catch (e) {
 *   if (e instanceof TxDryRunError) {
 *     console.log(e.revertReason); // "InsufficientBalance" (if contract provided one)
 *     console.log(e.formatted);    // "Revive.StorageDepositNotEnoughFunds"
 *   }
 * }
 * ```
 */
export class TxDryRunError extends TxError {
    /** The raw dry-run result for programmatic inspection. */
    readonly raw: unknown;
    /** Human-readable error string derived from the dry-run result. */
    readonly formatted: string;
    /** Solidity revert reason, if the contract provided one. */
    readonly revertReason?: string;

    constructor(raw: unknown, formatted: string, revertReason?: string) {
        super(revertReason ? `Dry run failed: ${revertReason}` : `Dry run failed: ${formatted}`);
        this.name = "TxDryRunError";
        this.raw = raw;
        this.formatted = formatted;
        this.revertReason = revertReason;
    }
}

/**
 * Extract a human-readable error from a failed dry-run result.
 *
 * Handles every error shape found across the Polkadot contract ecosystem:
 *
 * 1. **Revert reason** (Ink SDK patched results / EVM contracts):
 *    `{ value: { revertReason: "InsufficientBalance" } }`
 *
 * 2. **Nested dispatch errors** (raw Ink SDK / pallet errors):
 *    `{ value: { type: "Module", value: { type: "Revive", value: { type: "StorageDepositNotEnoughFunds" } } } }`
 *    Delegates to {@link formatDispatchError} for the Module.Pallet.Error chain.
 *
 * 3. **ReviveApi runtime messages** (`eth_transact` / `ReviveApi.call`):
 *    `{ value: { type: "Message", value: "Insufficient balance for gas * price + value" } }`
 *
 * 4. **ReviveApi contract revert data**:
 *    `{ value: { type: "Data", value: "0x08c379a0..." } }`
 *
 * 5. **Wrapped raw errors** (patched SDK wrappers):
 *    `{ value: { raw: { type: "Message", value: "..." } } }`
 *
 * 6. **Generic error field**:
 *    `{ error: { type: "ContractTrapped" } }` or `{ error: { name: "..." } }`
 *
 * @param result - A dry-run result with at least `success`, and optionally `value` / `error`.
 * @returns A human-readable error string, or `""` if the result succeeded.
 */
export function formatDryRunError(result: {
    success?: boolean;
    value?: unknown;
    error?: unknown;
}): string {
    if (result.success) return "";

    const formatted = extractErrorFromValue(result.value);
    if (formatted) return formatted;

    // Generic error field (Ink SDK)
    if (result.error != null && typeof result.error === "object") {
        const err = result.error as Record<string, unknown>;
        if (typeof err.type === "string") return err.type;
        if (typeof err.name === "string") return err.name;
    }

    return "unknown error";
}

/**
 * Try to extract an error string from the `value` field of a dry-run result.
 * Returns `undefined` if no known error shape is found.
 */
function extractErrorFromValue(value: unknown): string | undefined {
    if (value == null || typeof value !== "object") return undefined;
    const v = value as Record<string, unknown>;

    // Explicit revert reason — most specific, from Ink SDK / EVM wrappers
    if (typeof v.revertReason === "string" && v.revertReason) {
        return v.revertReason;
    }

    if (typeof v.type === "string") {
        // Nested Module.Pallet.Error — reuse dispatch error formatting
        if (v.type === "Module") {
            const asDispatch = formatDispatchError({ ok: false, dispatchError: value });
            if (asDispatch !== "unknown error") return asDispatch;
        }

        // ReviveApi Message — runtime error string
        if (v.type === "Message" && typeof v.value === "string") {
            return v.value;
        }

        // ReviveApi Data — contract revert hex data
        if (v.type === "Data") {
            const hex =
                v.value != null &&
                typeof v.value === "object" &&
                typeof (v.value as { asHex?: unknown }).asHex === "function"
                    ? String((v.value as { asHex: () => string }).asHex())
                    : typeof v.value === "string"
                      ? v.value
                      : undefined;
            return hex ? `contract reverted with data: ${hex}` : "contract reverted";
        }

        // Any other typed error (e.g., "BadOrigin", "ContractTrapped")
        return v.type;
    }

    // Wrapped raw value — patched SDK nests the original error under `raw`
    if ("raw" in v && v.raw != null && typeof v.raw === "object") {
        return extractErrorFromValue(v.raw);
    }

    return undefined;
}

/**
 * Check if an error looks like a user-rejected signing request.
 *
 * Different wallets use different error messages when the user rejects signing:
 * "Cancelled", "Rejected", "User rejected", "denied". This checks for common
 * patterns as a best-effort heuristic. Non-Error values always return false.
 *
 * @param error - The error to check.
 * @returns `true` if the error message matches a known rejection pattern.
 */
export function isSigningRejection(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return (
        msg.includes("cancelled") ||
        msg.includes("rejected") ||
        msg.includes("denied") ||
        msg.includes("user refused")
    );
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("TxError hierarchy", () => {
        test("TxTimeoutError", () => {
            const err = new TxTimeoutError(300_000);
            expect(err).toBeInstanceOf(TxError);
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("TxTimeoutError");
            expect(err.timeoutMs).toBe(300_000);
            expect(err.message).toContain("300s");
        });

        test("TxDispatchError", () => {
            const raw = {
                type: "Module",
                value: { type: "Balances", value: { type: "InsufficientBalance" } },
            };
            const err = new TxDispatchError(raw, "Balances.InsufficientBalance");
            expect(err).toBeInstanceOf(TxError);
            expect(err.name).toBe("TxDispatchError");
            expect(err.dispatchError).toBe(raw);
            expect(err.formatted).toBe("Balances.InsufficientBalance");
            expect(err.message).toContain("Balances.InsufficientBalance");
        });

        test("TxSigningRejectedError", () => {
            const err = new TxSigningRejectedError();
            expect(err).toBeInstanceOf(TxError);
            expect(err.name).toBe("TxSigningRejectedError");
        });

        test("TxBatchError", () => {
            const err = new TxBatchError("Cannot batch zero calls");
            expect(err).toBeInstanceOf(TxError);
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("TxBatchError");
            expect(err.message).toBe("Cannot batch zero calls");
        });
    });

    describe("formatDispatchError", () => {
        test("returns empty string for ok result", () => {
            expect(formatDispatchError({ ok: true })).toBe("");
        });

        test("walks Module.Pallet.Error chain", () => {
            const result = {
                ok: false,
                dispatchError: {
                    type: "Module",
                    value: { type: "Revive", value: { type: "ContractReverted" } },
                },
            };
            expect(formatDispatchError(result)).toBe("Revive.ContractReverted");
        });

        test("returns pallet name when inner error has no type", () => {
            const result = {
                ok: false,
                dispatchError: {
                    type: "Module",
                    value: { type: "Balances", value: {} },
                },
            };
            expect(formatDispatchError(result)).toBe("Balances");
        });

        test("returns error type for non-Module errors", () => {
            const result = {
                ok: false,
                dispatchError: { type: "BadOrigin" },
            };
            expect(formatDispatchError(result)).toBe("BadOrigin");
        });

        test("returns unknown error when dispatchError is missing", () => {
            expect(formatDispatchError({ ok: false })).toBe("unknown error");
        });

        test("returns unknown error when dispatchError has no type", () => {
            expect(formatDispatchError({ ok: false, dispatchError: {} })).toBe("unknown error");
        });
    });

    describe("TxDryRunError", () => {
        test("with revert reason", () => {
            const err = new TxDryRunError(
                { success: false },
                "Module.Error",
                "InsufficientBalance",
            );
            expect(err).toBeInstanceOf(TxError);
            expect(err.name).toBe("TxDryRunError");
            expect(err.formatted).toBe("Module.Error");
            expect(err.revertReason).toBe("InsufficientBalance");
            expect(err.message).toContain("InsufficientBalance");
        });

        test("without revert reason uses formatted", () => {
            const err = new TxDryRunError({ success: false }, "BadOrigin");
            expect(err.message).toContain("BadOrigin");
            expect(err.revertReason).toBeUndefined();
        });

        test("preserves raw result for inspection", () => {
            const raw = { success: false, value: { type: "Module" } };
            const err = new TxDryRunError(raw, "Module");
            expect(err.raw).toBe(raw);
        });
    });

    describe("formatDryRunError", () => {
        test("returns empty string for successful result", () => {
            expect(formatDryRunError({ success: true })).toBe("");
        });

        test("extracts revert reason", () => {
            expect(
                formatDryRunError({
                    success: false,
                    value: { revertReason: "InsufficientBalance" },
                }),
            ).toBe("InsufficientBalance");
        });

        test("walks Module.Pallet.Error chain", () => {
            expect(
                formatDryRunError({
                    success: false,
                    value: {
                        type: "Module",
                        value: { type: "Revive", value: { type: "StorageDepositNotEnoughFunds" } },
                    },
                }),
            ).toBe("Revive.StorageDepositNotEnoughFunds");
        });

        test("returns pallet name when inner error has no type", () => {
            expect(
                formatDryRunError({
                    success: false,
                    value: { type: "Module", value: { type: "Balances", value: {} } },
                }),
            ).toBe("Balances");
        });

        test("extracts ReviveApi Message string", () => {
            expect(
                formatDryRunError({
                    success: false,
                    value: {
                        type: "Message",
                        value: "Insufficient balance for gas * price + value",
                    },
                }),
            ).toBe("Insufficient balance for gas * price + value");
        });

        test("handles ReviveApi Data with string hex", () => {
            expect(
                formatDryRunError({
                    success: false,
                    value: { type: "Data", value: "0x08c379a0" },
                }),
            ).toBe("contract reverted with data: 0x08c379a0");
        });

        test("handles ReviveApi Data with Binary-like object", () => {
            const binary = { asHex: () => "0xdeadbeef" };
            expect(
                formatDryRunError({ success: false, value: { type: "Data", value: binary } }),
            ).toBe("contract reverted with data: 0xdeadbeef");
        });

        test("handles ReviveApi Data with no extractable hex", () => {
            expect(formatDryRunError({ success: false, value: { type: "Data", value: 42 } })).toBe(
                "contract reverted",
            );
        });

        test("returns non-Module/Message type directly", () => {
            expect(formatDryRunError({ success: false, value: { type: "BadOrigin" } })).toBe(
                "BadOrigin",
            );
        });

        test("extracts from nested raw field (patched SDK)", () => {
            expect(
                formatDryRunError({
                    success: false,
                    value: { raw: { type: "Message", value: "out of gas" } },
                }),
            ).toBe("out of gas");
        });

        test("extracts revertReason from nested raw", () => {
            expect(
                formatDryRunError({
                    success: false,
                    value: { raw: { revertReason: "Unauthorized" } },
                }),
            ).toBe("Unauthorized");
        });

        test("falls back to error.type", () => {
            expect(formatDryRunError({ success: false, error: { type: "ContractTrapped" } })).toBe(
                "ContractTrapped",
            );
        });

        test("falls back to error.name", () => {
            expect(formatDryRunError({ success: false, error: { name: "ExecutionFailed" } })).toBe(
                "ExecutionFailed",
            );
        });

        test("returns unknown error when nothing is extractable", () => {
            expect(formatDryRunError({ success: false })).toBe("unknown error");
        });

        test("returns unknown error for empty value and error", () => {
            expect(formatDryRunError({ success: false, value: {}, error: {} })).toBe(
                "unknown error",
            );
        });

        test("returns unknown error for null value", () => {
            expect(formatDryRunError({ success: false, value: null })).toBe("unknown error");
        });

        test("prefers revertReason over Module error", () => {
            // When both are present, revertReason is more specific
            expect(
                formatDryRunError({
                    success: false,
                    value: {
                        revertReason: "OwnableUnauthorizedAccount",
                        type: "Module",
                        value: {},
                    },
                }),
            ).toBe("OwnableUnauthorizedAccount");
        });
    });

    describe("isSigningRejection", () => {
        test("detects common rejection messages", () => {
            expect(isSigningRejection(new Error("Cancelled"))).toBe(true);
            expect(isSigningRejection(new Error("User rejected the request"))).toBe(true);
            expect(isSigningRejection(new Error("Transaction was rejected by user"))).toBe(true);
            expect(isSigningRejection(new Error("User denied"))).toBe(true);
            expect(isSigningRejection(new Error("Signing was denied by user"))).toBe(true);
            expect(isSigningRejection(new Error("User refused to sign"))).toBe(true);
        });

        test("returns false for non-rejection errors", () => {
            expect(isSigningRejection(new Error("Network timeout"))).toBe(false);
            expect(isSigningRejection(new Error("Insufficient balance"))).toBe(false);
        });

        test("returns false for non-Error values", () => {
            expect(isSigningRejection("cancelled")).toBe(false);
            expect(isSigningRejection(null)).toBe(false);
        });
    });
}
