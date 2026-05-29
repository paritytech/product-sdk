// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ProviderType } from "./types.js";

/** Base class for all signer errors. Use `instanceof SignerError` to catch any signer-related error. */
export class SignerError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SignerError";
    }
}

/** The Host API is not available (product-sdk not installed or not inside a container). */
export class HostUnavailableError extends SignerError {
    constructor(message = "Host API is not available") {
        super(message);
        this.name = "HostUnavailableError";
    }
}

/** The host rejected the account or signing request. */
export class HostRejectedError extends SignerError {
    constructor(message = "Host rejected the request") {
        super(message);
        this.name = "HostRejectedError";
    }
}

/** The host connection was lost. */
export class HostDisconnectedError extends SignerError {
    constructor(message = "Host connection lost") {
        super(message);
        this.name = "HostDisconnectedError";
    }
}

/** A signing operation failed. */
export class SigningFailedError extends SignerError {
    constructor(cause: unknown, message?: string) {
        super(
            message ?? `Signing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
        this.name = "SigningFailedError";
    }
}

/** No accounts available from the provider. */
export class NoAccountsError extends SignerError {
    readonly provider: ProviderType;

    constructor(provider: ProviderType, message?: string) {
        super(message ?? `No accounts available from ${provider} provider`);
        this.name = "NoAccountsError";
        this.provider = provider;
    }
}

/** An operation timed out. */
export class TimeoutError extends SignerError {
    readonly operation: string;
    readonly ms: number;

    constructor(operation: string, ms: number) {
        super(`Operation "${operation}" timed out after ${ms}ms`);
        this.name = "TimeoutError";
        this.operation = operation;
        this.ms = ms;
    }
}

/** An account was not found by address. */
export class AccountNotFoundError extends SignerError {
    readonly address: string;

    constructor(address: string) {
        super(`Account not found: ${address}`);
        this.name = "AccountNotFoundError";
        this.address = address;
    }
}

/** The SignerManager has been destroyed and is no longer usable. */
export class DestroyedError extends SignerError {
    constructor() {
        super("SignerManager has been destroyed");
        this.name = "DestroyedError";
    }
}

// ── Type guards ──────────────────────────────────────────────────────

/** Check if a SignerError is a host-related error. */
export function isHostError(
    e: SignerError,
): e is HostUnavailableError | HostRejectedError | HostDisconnectedError {
    return (
        e instanceof HostUnavailableError ||
        e instanceof HostRejectedError ||
        e instanceof HostDisconnectedError
    );
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("error classes", () => {
        test("SignerError is the base class", () => {
            const e = new HostUnavailableError();
            expect(e).toBeInstanceOf(SignerError);
            expect(e).toBeInstanceOf(Error);
        });

        test("HostUnavailableError with default message", () => {
            const e = new HostUnavailableError();
            expect(e.name).toBe("HostUnavailableError");
            expect(e.message).toBe("Host API is not available");
        });

        test("HostUnavailableError with custom message", () => {
            const e = new HostUnavailableError("custom");
            expect(e.message).toBe("custom");
        });

        test("HostRejectedError", () => {
            const e = new HostRejectedError();
            expect(e).toBeInstanceOf(SignerError);
            expect(e.message).toContain("rejected");
        });

        test("HostDisconnectedError", () => {
            const e = new HostDisconnectedError();
            expect(e).toBeInstanceOf(SignerError);
            expect(e.message).toContain("lost");
        });

        test("SigningFailedError with Error cause", () => {
            const cause = new Error("bad signature");
            const e = new SigningFailedError(cause);
            expect(e).toBeInstanceOf(SignerError);
            expect(e.cause).toBe(cause);
            expect(e.message).toContain("bad signature");
        });

        test("SigningFailedError with string cause", () => {
            const e = new SigningFailedError("oops");
            expect(e.message).toContain("oops");
        });

        test("SigningFailedError with custom message", () => {
            const e = new SigningFailedError("oops", "custom msg");
            expect(e.message).toBe("custom msg");
        });

        test("NoAccountsError", () => {
            const e = new NoAccountsError("host");
            expect(e).toBeInstanceOf(SignerError);
            expect(e.provider).toBe("host");
            expect(e.message).toContain("host");
        });

        test("NoAccountsError with custom message", () => {
            const e = new NoAccountsError("dev", "none found");
            expect(e.message).toBe("none found");
        });

        test("TimeoutError", () => {
            const e = new TimeoutError("connect", 5000);
            expect(e).toBeInstanceOf(SignerError);
            expect(e.operation).toBe("connect");
            expect(e.ms).toBe(5000);
            expect(e.message).toContain("5000");
        });

        test("AccountNotFoundError", () => {
            const e = new AccountNotFoundError("5GrwvaEF...");
            expect(e).toBeInstanceOf(SignerError);
            expect(e.address).toBe("5GrwvaEF...");
        });

        test("DestroyedError", () => {
            const e = new DestroyedError();
            expect(e).toBeInstanceOf(SignerError);
            expect(e.message).toContain("destroyed");
        });

        test("all errors have stack traces", () => {
            const e = new HostUnavailableError();
            expect(e.stack).toBeDefined();
            expect(e.stack).toContain("HostUnavailableError");
        });
    });

    describe("type guards", () => {
        test("isHostError returns true for host errors", () => {
            expect(isHostError(new HostUnavailableError())).toBe(true);
            expect(isHostError(new HostRejectedError())).toBe(true);
            expect(isHostError(new HostDisconnectedError())).toBe(true);
        });

        test("isHostError returns false for non-host errors", () => {
            expect(isHostError(new SigningFailedError("x"))).toBe(false);
            expect(isHostError(new NoAccountsError("dev"))).toBe(false);
            expect(isHostError(new TimeoutError("op", 100))).toBe(false);
            expect(isHostError(new AccountNotFoundError("x"))).toBe(false);
            expect(isHostError(new DestroyedError())).toBe(false);
        });
    });
}
