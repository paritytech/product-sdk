// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Cloud Storage error types.
 *
 * Two error families coexist:
 *
 * 1. **Upstream SDK errors** — `BulletinError` and `ErrorCode` from
 *    `@parity/bulletin-sdk` cover upload/store/authorization failures
 *    surfaced by `AsyncBulletinClient`. Each carries `code`, `retryable`,
 *    and `recoveryHint`.
 * 2. **Read-side errors** declared here — host preimage availability /
 *    lookup timeouts / interrupts, plus CID format problems, surfaced by
 *    our retrieval helpers (`fetchBytes`, `fetchJson`, `verifyStored`).
 *
 * Catch upstream errors with `instanceof BulletinError`. Catch our read-side
 * errors with `instanceof ProductCloudStorageError` (or the specific subclass).
 */
export { BulletinError, ErrorCode } from "@parity/bulletin-sdk";

/**
 * Base class for read-side errors raised by `@parity/product-sdk-cloud-storage`.
 *
 * Distinct from upstream `BulletinError` which covers upload/store failures.
 */
export class ProductCloudStorageError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ProductCloudStorageError";
    }
}

/**
 * The host preimage API is unavailable.
 *
 * Thrown when cloud storage operations require the host container but it's not
 * available. This typically means the SDK is running outside Polkadot
 * Browser / Desktop. The Cloud Storage SDK is container-only by design — see
 * the README for the rationale.
 */
export class CloudStorageHostUnavailableError extends ProductCloudStorageError {
    constructor(operation: "upload" | "query") {
        super(
            `Host preimage API unavailable for ${operation}. Ensure you are running inside a host container (Polkadot Browser / Desktop).`,
        );
        this.name = "CloudStorageHostUnavailableError";
    }
}

/**
 * The host preimage lookup timed out.
 *
 * The host was unable to retrieve the requested content within the timeout
 * period. The content may still become available later.
 */
export class CloudStorageLookupTimeoutError extends ProductCloudStorageError {
    /** The CID that was being looked up. */
    readonly cid: string;
    /** The timeout duration in milliseconds. */
    readonly timeoutMs: number;

    constructor(cid: string, timeoutMs: number) {
        super(`Host preimage lookup timed out after ${timeoutMs}ms for CID: ${cid}`);
        this.name = "CloudStorageLookupTimeoutError";
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
export class CloudStorageLookupInterruptedError extends ProductCloudStorageError {
    /** The CID that was being looked up. */
    readonly cid: string;

    constructor(cid: string) {
        super(`Host preimage lookup was interrupted for CID: ${cid}`);
        this.name = "CloudStorageLookupInterruptedError";
        this.cid = cid;
    }
}

/**
 * Invalid CID format or version.
 */
export class CloudStorageCidError extends ProductCloudStorageError {
    /** The invalid CID string, if available. */
    readonly cid?: string;

    constructor(message: string, cid?: string) {
        super(message);
        this.name = "CloudStorageCidError";
        this.cid = cid;
    }
}

/**
 * Failed to check authorization status for an account.
 *
 * Wraps RPC or query errors that occur when checking if an account
 * is authorized to store data in Cloud Storage.
 */
export class CloudStorageAuthorizationError extends ProductCloudStorageError {
    /** The address that was being checked. */
    readonly address: string;

    constructor(address: string, cause?: unknown) {
        super(`Failed to check authorization for ${address}`, { cause });
        this.name = "CloudStorageAuthorizationError";
        this.address = address;
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("ProductCloudStorageError hierarchy", () => {
        test("ProductCloudStorageError extends Error", () => {
            const err = new ProductCloudStorageError("test");
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("ProductCloudStorageError");
        });

        test("CloudStorageCidError", () => {
            const err = new CloudStorageCidError("bad", "Qmabc");
            expect(err).toBeInstanceOf(ProductCloudStorageError);
            expect(err.cid).toBe("Qmabc");
        });

        test("CloudStorageinHostUnavailableError", () => {
            const err = new CloudStorageHostUnavailableError("query");
            expect(err).toBeInstanceOf(ProductCloudStorageError);
            expect(err.message).toContain("query");
            expect(err.message).toContain("Host preimage API unavailable");
        });

        test("CloudStorageLookupTimeoutError", () => {
            const err = new CloudStorageLookupTimeoutError("bafyabc123", 30000);
            expect(err).toBeInstanceOf(ProductCloudStorageError);
            expect(err.cid).toBe("bafyabc123");
            expect(err.timeoutMs).toBe(30000);
            expect(err.message).toContain("30000ms");
        });

        test("CloudStorageLookupInterruptedError", () => {
            const err = new CloudStorageLookupInterruptedError("bafyabc123");
            expect(err).toBeInstanceOf(ProductCloudStorageError);
            expect(err.cid).toBe("bafyabc123");
            expect(err.message).toContain("interrupted");
        });

        test("CloudStorageAuthorizationError carries cause", () => {
            const cause = new Error("RPC down");
            const err = new CloudStorageAuthorizationError("5GrwvaEF...", cause);
            expect(err).toBeInstanceOf(ProductCloudStorageError);
            expect(err.address).toBe("5GrwvaEF...");
            expect(err.cause).toBe(cause);
        });
    });
}
