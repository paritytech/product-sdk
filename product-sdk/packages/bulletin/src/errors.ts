/**
 * Bulletin error types.
 *
 * Two error families coexist:
 *
 * 1. **Upstream SDK errors** — `BulletinError` and `ErrorCode` from
 *    `@parity/bulletin-sdk` cover upload/store/authorization failures
 *    surfaced by `AsyncBulletinClient`. Each carries `code`, `retryable`,
 *    and `recoveryHint`.
 * 2. **Read-side errors** declared here — gateway availability/fetch failures
 *    and CID format problems, surfaced by our retrieval helpers.
 *
 * Catch upstream errors with `instanceof BulletinError`. Catch our read-side
 * errors with `instanceof ProductBulletinError` (or the specific subclass).
 */
export { BulletinError, ErrorCode } from "@parity/bulletin-sdk";

/**
 * Base class for read-side errors raised by `@parity/product-sdk-bulletin`.
 *
 * Distinct from upstream `BulletinError` which covers upload/store failures.
 */
export class ProductBulletinError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ProductBulletinError";
    }
}

/**
 * The IPFS gateway for the specified environment is not available.
 */
export class BulletinGatewayUnavailableError extends ProductBulletinError {
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
 */
export class BulletinGatewayFetchError extends ProductBulletinError {
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
 * The host preimage API is unavailable.
 *
 * Thrown when bulletin operations require the host container but it's not
 * available. This typically means the SDK is running outside Polkadot
 * Browser / Desktop. The bulletin SDK is container-only by design — see
 * the README for the rationale.
 */
export class BulletinHostUnavailableError extends ProductBulletinError {
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
 * The host was unable to retrieve the requested content within the timeout
 * period. The content may still become available later.
 */
export class BulletinLookupTimeoutError extends ProductBulletinError {
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
 * The host terminated the lookup subscription, typically after repeated
 * failures or when the host determines the content is unavailable.
 */
export class BulletinLookupInterruptedError extends ProductBulletinError {
    /** The CID that was being looked up. */
    readonly cid: string;

    constructor(cid: string) {
        super(`Host preimage lookup was interrupted for CID: ${cid}`);
        this.name = "BulletinLookupInterruptedError";
        this.cid = cid;
    }
}

/**
 * Invalid CID format or version.
 */
export class BulletinCidError extends ProductBulletinError {
    /** The invalid CID string, if available. */
    readonly cid?: string;

    constructor(message: string, cid?: string) {
        super(message);
        this.name = "BulletinCidError";
        this.cid = cid;
    }
}

/**
 * Failed to check authorization status for an account.
 *
 * Wraps RPC or query errors that occur when checking if an account
 * is authorized to store data on the Bulletin Chain.
 */
export class BulletinAuthorizationError extends ProductBulletinError {
    /** The address that was being checked. */
    readonly address: string;

    constructor(address: string, cause?: unknown) {
        super(`Failed to check authorization for ${address}`, { cause });
        this.name = "BulletinAuthorizationError";
        this.address = address;
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("ProductBulletinError hierarchy", () => {
        test("ProductBulletinError extends Error", () => {
            const err = new ProductBulletinError("test");
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("ProductBulletinError");
        });

        test("BulletinGatewayUnavailableError", () => {
            const err = new BulletinGatewayUnavailableError("polkadot");
            expect(err).toBeInstanceOf(ProductBulletinError);
            expect(err.environment).toBe("polkadot");
            expect(err.message).toContain("polkadot");
        });

        test("BulletinGatewayFetchError", () => {
            const err = new BulletinGatewayFetchError("bafyabc", 404, "Not Found");
            expect(err).toBeInstanceOf(ProductBulletinError);
            expect(err.cid).toBe("bafyabc");
            expect(err.status).toBe(404);
            expect(err.message).toContain("404");
        });

        test("BulletinCidError", () => {
            const err = new BulletinCidError("bad", "Qmabc");
            expect(err).toBeInstanceOf(ProductBulletinError);
            expect(err.cid).toBe("Qmabc");
        });

        test("BulletinHostUnavailableError", () => {
            const err = new BulletinHostUnavailableError("query");
            expect(err).toBeInstanceOf(ProductBulletinError);
            expect(err.message).toContain("query");
            expect(err.message).toContain("Host preimage API unavailable");
        });

        test("BulletinLookupTimeoutError", () => {
            const err = new BulletinLookupTimeoutError("bafyabc123", 30000);
            expect(err).toBeInstanceOf(ProductBulletinError);
            expect(err.cid).toBe("bafyabc123");
            expect(err.timeoutMs).toBe(30000);
            expect(err.message).toContain("30000ms");
        });

        test("BulletinLookupInterruptedError", () => {
            const err = new BulletinLookupInterruptedError("bafyabc123");
            expect(err).toBeInstanceOf(ProductBulletinError);
            expect(err.cid).toBe("bafyabc123");
            expect(err.message).toContain("interrupted");
        });

        test("BulletinAuthorizationError carries cause", () => {
            const cause = new Error("RPC down");
            const err = new BulletinAuthorizationError("5GrwvaEF...", cause);
            expect(err).toBeInstanceOf(ProductBulletinError);
            expect(err.address).toBe("5GrwvaEF...");
            expect(err.cause).toBe(cause);
        });
    });
}
