/**
 * Base class for all Bulletin Chain errors.
 *
 * Use `instanceof BulletinError` to catch any bulletin-related error.
 *
 * @example
 * ```ts
 * try {
 *   await bulletin.upload(data);
 * } catch (e) {
 *   if (e instanceof BulletinError) {
 *     console.error("Bulletin operation failed:", e.message);
 *   }
 * }
 * ```
 */
export class BulletinError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "BulletinError";
    }
}

/**
 * The host preimage API is unavailable.
 *
 * Thrown when bulletin operations require the host container but it's not available.
 * This typically means the SDK is running outside of Polkadot Browser/Desktop.
 */
export class BulletinHostUnavailableError extends BulletinError {
    constructor(operation: "upload" | "query") {
        super(
            `Host preimage API unavailable for ${operation}. Ensure you are running inside a host container (Polkadot Browser / Desktop).`,
        );
        this.name = "BulletinHostUnavailableError";
    }
}

/**
 * The host preimage lookup timed out.
 *
 * The host was unable to retrieve the requested content within the timeout period.
 * The content may still become available later.
 */
export class BulletinLookupTimeoutError extends BulletinError {
    /** The CID that was being looked up. */
    readonly cid: string;
    /** The timeout duration in milliseconds. */
    readonly timeoutMs: number;

    constructor(cid: string, timeoutMs: number) {
        super(`Host preimage lookup timed out after ${timeoutMs}ms for CID: ${cid}`);
        this.name = "BulletinLookupTimeoutError";
        this.cid = cid;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * The host interrupted the preimage lookup.
 *
 * The host terminated the lookup subscription, typically after repeated failures
 * or when the host determines the content is unavailable.
 */
export class BulletinLookupInterruptedError extends BulletinError {
    /** The CID that was being looked up. */
    readonly cid: string;

    constructor(cid: string) {
        super(`Host preimage lookup was interrupted for CID: ${cid}`);
        this.name = "BulletinLookupInterruptedError";
        this.cid = cid;
    }
}

/**
 * Failed to check authorization status for an account.
 *
 * Wraps RPC or query errors that occur when checking if an account
 * is authorized to store data on the Bulletin Chain.
 */
export class BulletinAuthorizationError extends BulletinError {
    /** The address that was being checked. */
    readonly address: string;

    constructor(address: string, cause?: unknown) {
        super(`Failed to check authorization for ${address}`, { cause });
        this.name = "BulletinAuthorizationError";
        this.address = address;
    }
}

/**
 * The IPFS gateway for the specified environment is not available.
 *
 * Thrown when attempting to use gateway features for a network that
 * doesn't have a live bulletin gateway yet.
 */
export class BulletinGatewayUnavailableError extends BulletinError {
    /** The environment that was requested. */
    readonly environment: string;

    constructor(environment: string) {
        super(`Bulletin gateway for "${environment}" is not yet available`);
        this.name = "BulletinGatewayUnavailableError";
        this.environment = environment;
    }
}

/**
 * An IPFS gateway request failed.
 *
 * Thrown when a fetch to the IPFS gateway returns a non-OK response.
 */
export class BulletinGatewayFetchError extends BulletinError {
    /** The CID that was being fetched. */
    readonly cid: string;
    /** The HTTP status code returned by the gateway. */
    readonly status: number;
    /** The HTTP status text returned by the gateway. */
    readonly statusText: string;

    constructor(cid: string, status: number, statusText: string) {
        super(`Gateway fetch failed for ${cid}: ${status} ${statusText}`);
        this.name = "BulletinGatewayFetchError";
        this.cid = cid;
        this.status = status;
        this.statusText = statusText;
    }
}

/**
 * Invalid CID format or version.
 *
 * Thrown when a CID string cannot be parsed or has an unexpected version/codec.
 */
export class BulletinCidError extends BulletinError {
    /** The invalid CID string, if available. */
    readonly cid?: string;

    constructor(message: string, cid?: string) {
        super(message);
        this.name = "BulletinCidError";
        this.cid = cid;
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("BulletinError hierarchy", () => {
        test("BulletinError is instanceof Error", () => {
            const err = new BulletinError("test");
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinError");
        });

        test("BulletinHostUnavailableError", () => {
            const err = new BulletinHostUnavailableError("upload");
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinHostUnavailableError");
            expect(err.message).toContain("upload");
            expect(err.message).toContain("Host preimage API unavailable");
        });

        test("BulletinLookupTimeoutError", () => {
            const err = new BulletinLookupTimeoutError("bafyabc123", 30000);
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinLookupTimeoutError");
            expect(err.cid).toBe("bafyabc123");
            expect(err.timeoutMs).toBe(30000);
            expect(err.message).toContain("30000ms");
            expect(err.message).toContain("bafyabc123");
        });

        test("BulletinLookupInterruptedError", () => {
            const err = new BulletinLookupInterruptedError("bafyabc123");
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinLookupInterruptedError");
            expect(err.cid).toBe("bafyabc123");
            expect(err.message).toContain("interrupted");
        });

        test("BulletinAuthorizationError with cause", () => {
            const cause = new Error("RPC timeout");
            const err = new BulletinAuthorizationError("5GrwvaEF...", cause);
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinAuthorizationError");
            expect(err.address).toBe("5GrwvaEF...");
            expect(err.cause).toBe(cause);
        });

        test("BulletinGatewayUnavailableError", () => {
            const err = new BulletinGatewayUnavailableError("polkadot");
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinGatewayUnavailableError");
            expect(err.environment).toBe("polkadot");
            expect(err.message).toContain("polkadot");
        });

        test("BulletinGatewayFetchError", () => {
            const err = new BulletinGatewayFetchError("bafyabc", 404, "Not Found");
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinGatewayFetchError");
            expect(err.cid).toBe("bafyabc");
            expect(err.status).toBe(404);
            expect(err.statusText).toBe("Not Found");
            expect(err.message).toContain("404");
        });

        test("BulletinCidError", () => {
            const err = new BulletinCidError("Expected CIDv1, got CIDv0", "Qmabc");
            expect(err).toBeInstanceOf(BulletinError);
            expect(err.name).toBe("BulletinCidError");
            expect(err.cid).toBe("Qmabc");
        });

        test("all errors can be caught with BulletinError", () => {
            const errors = [
                new BulletinHostUnavailableError("query"),
                new BulletinLookupTimeoutError("cid", 1000),
                new BulletinLookupInterruptedError("cid"),
                new BulletinAuthorizationError("addr"),
                new BulletinGatewayUnavailableError("env"),
                new BulletinGatewayFetchError("cid", 500, "Error"),
                new BulletinCidError("bad cid"),
            ];

            for (const err of errors) {
                expect(err).toBeInstanceOf(BulletinError);
            }
        });
    });
}
