// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { MAX_STATEMENT_SIZE } from "./types.js";

/**
 * Base class for all statement store errors.
 *
 * Use `instanceof StatementStoreError` to catch any error originating
 * from the statement store package.
 */
export class StatementStoreError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "StatementStoreError";
    }
}

/**
 * A SCALE encoding or decoding operation failed.
 *
 * Thrown when statement bytes cannot be parsed (corrupt data, unknown field tags)
 * or when encoding produces invalid output.
 */
export class StatementEncodingError extends StatementStoreError {
    constructor(message: string, options?: ErrorOptions) {
        super(`Encoding error: ${message}`, options);
        this.name = "StatementEncodingError";
    }
}

/**
 * The statement store node rejected a submitted statement.
 *
 * Carries the raw RPC response detail for programmatic inspection.
 */
export class StatementSubmitError extends StatementStoreError {
    /** The raw response from the RPC call. */
    readonly detail: unknown;

    constructor(detail: unknown) {
        super(`Statement submission rejected: ${JSON.stringify(detail)}`);
        this.name = "StatementSubmitError";
        this.detail = detail;
    }
}

/**
 * Failed to set up or maintain a statement subscription.
 *
 * This is a non-fatal error — the client falls back to polling
 * when subscriptions are unavailable.
 */
export class StatementSubscriptionError extends StatementStoreError {
    constructor(message: string, options?: ErrorOptions) {
        super(`Subscription error: ${message}`, options);
        this.name = "StatementSubscriptionError";
    }
}

/**
 * Failed to connect to the statement store transport.
 *
 * Thrown when the WebSocket connection cannot be established
 * or the chain-client's bulletin chain is not connected.
 */
export class StatementConnectionError extends StatementStoreError {
    constructor(message: string, options?: ErrorOptions) {
        super(`Connection error: ${message}`, options);
        this.name = "StatementConnectionError";
    }
}

/**
 * The statement data payload exceeds the maximum allowed size.
 *
 * The statement store protocol limits individual statement data
 * to {@link MAX_STATEMENT_SIZE} bytes (512 bytes).
 */
export class StatementDataTooLargeError extends StatementStoreError {
    /** The actual size of the data in bytes. */
    readonly actualSize: number;
    /** The maximum allowed size in bytes. */
    readonly maxSize: number;

    constructor(actualSize: number, maxSize: number = MAX_STATEMENT_SIZE) {
        super(`Statement data too large: ${actualSize} bytes exceeds maximum of ${maxSize} bytes`);
        this.name = "StatementDataTooLargeError";
        this.actualSize = actualSize;
        this.maxSize = maxSize;
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("StatementStoreError hierarchy", () => {
        test("StatementStoreError is instanceof Error", () => {
            const err = new StatementStoreError("test");
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(StatementStoreError);
            expect(err.name).toBe("StatementStoreError");
            expect(err.message).toBe("test");
        });

        test("StatementEncodingError", () => {
            const err = new StatementEncodingError("bad field tag");
            expect(err).toBeInstanceOf(StatementStoreError);
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe("StatementEncodingError");
            expect(err.message).toContain("bad field tag");
        });

        test("StatementEncodingError preserves cause", () => {
            const cause = new Error("original");
            const err = new StatementEncodingError("wrap", { cause });
            expect(err.cause).toBe(cause);
        });

        test("StatementSubmitError", () => {
            const detail = { status: "rejected", reason: "bad proof" };
            const err = new StatementSubmitError(detail);
            expect(err).toBeInstanceOf(StatementStoreError);
            expect(err.name).toBe("StatementSubmitError");
            expect(err.detail).toBe(detail);
            expect(err.message).toContain("rejected");
        });

        test("StatementSubscriptionError", () => {
            const err = new StatementSubscriptionError("not supported");
            expect(err).toBeInstanceOf(StatementStoreError);
            expect(err.name).toBe("StatementSubscriptionError");
            expect(err.message).toContain("not supported");
        });

        test("StatementConnectionError", () => {
            const err = new StatementConnectionError("timeout");
            expect(err).toBeInstanceOf(StatementStoreError);
            expect(err.name).toBe("StatementConnectionError");
            expect(err.message).toContain("timeout");
        });

        test("StatementDataTooLargeError", () => {
            const err = new StatementDataTooLargeError(600);
            expect(err).toBeInstanceOf(StatementStoreError);
            expect(err.name).toBe("StatementDataTooLargeError");
            expect(err.actualSize).toBe(600);
            expect(err.maxSize).toBe(512);
            expect(err.message).toContain("600");
            expect(err.message).toContain("512");
        });

        test("StatementDataTooLargeError with custom max", () => {
            const err = new StatementDataTooLargeError(2000, 1024);
            expect(err.actualSize).toBe(2000);
            expect(err.maxSize).toBe(1024);
        });

        test("all errors are catchable via base class", () => {
            const errors = [
                new StatementEncodingError("test"),
                new StatementSubmitError("test"),
                new StatementSubscriptionError("test"),
                new StatementConnectionError("test"),
                new StatementDataTooLargeError(600),
            ];
            for (const err of errors) {
                expect(err).toBeInstanceOf(StatementStoreError);
            }
        });
    });
}
