// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { HexString } from "polkadot-api";

/** Base class for all contract errors. Use `instanceof ContractError` to catch any contract-related error. */
export class ContractError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ContractError";
    }
}

/** No signer was available for a transaction call. */
export class ContractSignerMissingError extends ContractError {
    constructor() {
        super(
            "No signer available. Pass { signer } in call options, " +
                "set defaultSigner, or provide a signerManager.",
        );
        this.name = "ContractSignerMissingError";
    }
}

/** A contract was not found in the cdm.json manifest. */
export class ContractNotFoundError extends ContractError {
    readonly library: string;

    constructor(library: string) {
        super(`Contract "${library}" not found in cdm.json`);
        this.name = "ContractNotFoundError";
        this.library = library;
    }
}

/** Live CDM registry address resolution failed. */
export class ContractLiveAddressResolutionError extends ContractError {
    readonly library: string | undefined;
    readonly detail: unknown;

    constructor(
        message: string,
        options?: { library?: string; detail?: unknown; cause?: unknown },
    ) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "ContractLiveAddressResolutionError";
        this.library = options?.library;
        this.detail = options?.detail;
    }
}

/**
 * A pre-flight `ReviveApi.call` dry-run reported failure. Thrown from the `.tx()`
 * path before the extrinsic is built — prevents callers from paying gas on a
 * transaction the chain already told us would revert.
 *
 * `dispatchError` carries the chain's encoded error (typically `ModuleError`,
 * `ContractReverted`, `OutOfGas`, or `AccountNotMapped` — see the `Revive`
 * pallet error variants).
 */
export class ContractDryRunFailedError extends ContractError {
    readonly methodName: string;
    readonly dispatchError: unknown;

    constructor(methodName: string, dispatchError: unknown) {
        super(
            `Dry-run failed for "${methodName}": ${
                typeof dispatchError === "string" ? dispatchError : JSON.stringify(dispatchError)
            }. The transaction was not submitted.`,
        );
        this.name = "ContractDryRunFailedError";
        this.methodName = methodName;
        this.dispatchError = dispatchError;
    }
}

/** viem-decoded standard or ABI-defined contract error. */
export interface DecodedContractRevert {
    errorName: string;
    args: readonly unknown[] | undefined;
}

/**
 * Tagged-enum value surfaced on `QueryResult.value` when a contract reverts
 * via the REVERT flag. The discriminant is intentionally distinct from
 * `pallet-revive`'s bare `{ type: "ContractReverted" }` dispatch-error variant,
 * which is the other path that can populate `QueryResult.value` on failure.
 */
export interface ContractRevertInfo {
    type: "ContractRevertedWithPayload";
    data: HexString;
    reason?: string;
    decoded?: DecodedContractRevert;
}

// Top-level bigints stringify unquoted (`42`); bigints inside an object or
// array stringify as JSON strings (`"42"`) because that's the only way a
// JSON replacer can emit them. Tolerated since this string is only ever
// read by humans in an error message, not parsed.
function stringifyArg(arg: unknown): string {
    if (typeof arg === "bigint") return arg.toString();
    return JSON.stringify(arg, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** A contract call returned with the `REVERT` flag set on a dispatched-OK call. */
export class ContractRevertedError extends ContractError {
    readonly methodName: string;
    readonly data: HexString;
    readonly reason?: string;
    readonly decoded?: DecodedContractRevert;

    constructor(
        methodName: string,
        data: HexString,
        info?: { reason?: string; decoded?: DecodedContractRevert },
    ) {
        // `reason` already carries the human-readable message for Error and Panic,
        // so only fall back to `errorName(args...)` for ABI-defined custom errors.
        const suffix =
            info?.reason ??
            (info?.decoded
                ? `${info.decoded.errorName}(${(info.decoded.args ?? []).map(stringifyArg).join(", ")})`
                : data);
        super(
            `Contract reverted in "${methodName}": ${suffix}. The transaction was not submitted.`,
        );
        this.name = "ContractRevertedError";
        this.methodName = methodName;
        this.data = data;
        this.reason = info?.reason;
        this.decoded = info?.decoded;
    }
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("ContractError", () => {
        test("base error has correct name", () => {
            const err = new ContractError("test");
            expect(err.name).toBe("ContractError");
            expect(err).toBeInstanceOf(Error);
        });

        test("instanceof catches all contract errors", () => {
            expect(new ContractSignerMissingError()).toBeInstanceOf(ContractError);
            expect(new ContractNotFoundError("@a/b")).toBeInstanceOf(ContractError);
            expect(new ContractLiveAddressResolutionError("test")).toBeInstanceOf(ContractError);
            expect(new ContractDryRunFailedError("foo", "x")).toBeInstanceOf(ContractError);
            expect(new ContractRevertedError("foo", "0x" as HexString)).toBeInstanceOf(
                ContractError,
            );
        });
    });

    describe("ContractSignerMissingError", () => {
        test("message mentions signer options", () => {
            const err = new ContractSignerMissingError();
            expect(err.message).toContain("signer");
            expect(err.message).toContain("signerManager");
            expect(err.name).toBe("ContractSignerMissingError");
        });
    });

    describe("ContractNotFoundError", () => {
        test("includes library", () => {
            const err = new ContractNotFoundError("@test/foo");
            expect(err.library).toBe("@test/foo");
            expect(err.message).toBe('Contract "@test/foo" not found in cdm.json');
        });
    });

    describe("ContractLiveAddressResolutionError", () => {
        test("captures library and detail", () => {
            const detail = { success: false };
            const err = new ContractLiveAddressResolutionError("failed", {
                library: "@test/foo",
                detail,
            });
            expect(err.name).toBe("ContractLiveAddressResolutionError");
            expect(err.library).toBe("@test/foo");
            expect(err.detail).toBe(detail);
        });
    });

    describe("ContractDryRunFailedError", () => {
        test("captures method name and dispatch error", () => {
            const dispatchError = { type: "Module", value: { type: "Revive" } };
            const err = new ContractDryRunFailedError("transfer", dispatchError);
            expect(err.methodName).toBe("transfer");
            expect(err.dispatchError).toBe(dispatchError);
            expect(err.message).toContain("transfer");
            expect(err.message).toContain("not submitted");
            expect(err.name).toBe("ContractDryRunFailedError");
        });

        test("handles string dispatch error without JSON-stringifying", () => {
            const err = new ContractDryRunFailedError("foo", "ContractReverted");
            expect(err.message).toContain("ContractReverted");
            expect(err.message).not.toContain('"ContractReverted"');
        });
    });

    describe("ContractRevertedError", () => {
        test("captures method, raw data, reason, and decoded payload", () => {
            const data = "0x556e617574686f72697a6564" as HexString;
            const err = new ContractRevertedError("transfer", data, {
                reason: "Unauthorized",
                decoded: { errorName: "Error", args: ["Unauthorized"] },
            });
            expect(err.name).toBe("ContractRevertedError");
            expect(err.methodName).toBe("transfer");
            expect(err.data).toBe(data);
            expect(err.reason).toBe("Unauthorized");
            expect(err.decoded?.errorName).toBe("Error");
            // Error(string) prefers the bare reason over `Error("...")` form.
            expect(err.message).toBe(
                'Contract reverted in "transfer": Unauthorized. The transaction was not submitted.',
            );
        });

        test("falls back to reason then to raw data when decoded is absent", () => {
            const data = "0xdeadbeef" as HexString;
            const withReason = new ContractRevertedError("foo", data, { reason: "Whoops" });
            expect(withReason.message).toContain("Whoops");

            const noInfo = new ContractRevertedError("foo", data);
            expect(noInfo.message).toContain("0xdeadbeef");
            expect(noInfo.reason).toBeUndefined();
            expect(noInfo.decoded).toBeUndefined();
        });

        test("stringifies top-level bigint args without throwing", () => {
            const err = new ContractRevertedError("bar", "0x" as HexString, {
                decoded: { errorName: "InsufficientBalance", args: [42n, 100n] },
            });
            expect(err.message).toContain("InsufficientBalance(42, 100)");
        });

        test("stringifies nested bigint args inside a struct without throwing", () => {
            // viem returns `[{ owed: 42n }]` for struct args; the default
            // JSON.stringify replacer would throw on the nested bigint.
            const err = new ContractRevertedError("redeem", "0x" as HexString, {
                decoded: {
                    errorName: "Bad",
                    args: [{ owed: 42n, nested: { deeper: [7n, 9n] } }],
                },
            });
            expect(err.message).toContain('"owed":"42"');
            expect(err.message).toContain('"deeper":["7","9"]');
        });

        test("uses the Panic reason instead of Panic(<code>) when decodeRevert provided one", () => {
            // Regression: Panic reason used to be clobbered by the errorName(args) form.
            const err = new ContractRevertedError("withdraw", "0x" as HexString, {
                reason: "Panic: arithmetic overflow",
                decoded: { errorName: "Panic", args: [17n] },
            });
            expect(err.message).toContain("Panic: arithmetic overflow");
            expect(err.message).not.toContain("Panic(17)");
        });
    });
}
