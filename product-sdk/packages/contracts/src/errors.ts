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
    readonly targetHash: string;

    constructor(library: string, targetHash: string) {
        super(`Contract "${library}" not found in cdm.json for target ${targetHash}`);
        this.name = "ContractNotFoundError";
        this.library = library;
        this.targetHash = targetHash;
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
            expect(new ContractNotFoundError("@a/b", "abc")).toBeInstanceOf(ContractError);
            expect(new ContractDryRunFailedError("foo", "x")).toBeInstanceOf(ContractError);
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
        test("includes library and target", () => {
            const err = new ContractNotFoundError("@test/foo", "abc123");
            expect(err.library).toBe("@test/foo");
            expect(err.targetHash).toBe("abc123");
            expect(err.message).toContain("@test/foo");
            expect(err.message).toContain("abc123");
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
}
