// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Typed errors carried on the `err` channel of the host public API's
 * {@link Result} returns.
 *
 * The hierarchy mirrors `@parity/product-sdk-signer`'s error classes
 * (`HostUnavailableError` / `HostRejectedError`), so the two layers share one
 * idiom: branch with `instanceof`, and every error is a real `Error` with a
 * stack trace and `cause`. The structured truapi wire error
 * ({@link HostErrorPayload}) rides along as {@link HostCallFailedError.payload}
 * for callers that want fine-grained tag-level handling.
 *
 * This module also owns {@link HostErrorPayload} (the wire-error shape) and
 * {@link formatHostError} (renders a payload to a message) — co-located with the
 * error classes that consume them so the host error model lives in one place.
 *
 * @module
 */
import type { GenericError } from "@parity/truapi";

/**
 * The structured error payload `@parity/truapi` surfaces on the `Err` channel of
 * a host call, once unwrapped from the versioned wire envelope. Every host error
 * union is built from these:
 *
 * - the catch-all {@link GenericError} (`{ reason }`),
 * - a unit tagged variant (`{ tag }`), or
 * - a tagged variant carrying a reason (`{ tag, value: { reason } }`).
 *
 * `GenericError` is imported from `@parity/truapi`; the `{ tag }` members are a
 * deliberate widening of truapi's per-domain named variants (the formatter is
 * tag-agnostic). truapi has no umbrella error union to import today — once it
 * exports a canonical tagged-error union from codegen, replace these local
 * members with that import so the type is protocol-sourced rather than
 * hand-widened.
 *
 * This is the *payload* the host public API carries inside a
 * {@link HostCallFailedError} on the `err` channel of its `Result` returns — not
 * the error type consumers branch on.
 */
export type HostErrorPayload =
    | GenericError
    | { tag: string; value?: undefined }
    | { tag: string; value: { reason: string } };

/** Narrow an unknown `Err`-channel value to a {@link HostErrorPayload}. */
function isHostErrorPayload(error: unknown): error is HostErrorPayload {
    if (error == null || typeof error !== "object") return false;
    const obj = error as Record<string, unknown>;
    return typeof obj.reason === "string" || typeof obj.tag === "string";
}

/**
 * Extract a human-readable message from a host-side error.
 *
 * Renders the {@link HostErrorPayload} shapes `@parity/truapi` surfaces. Accepts
 * `unknown` because it is also the catch-all formatter for thrown adapter-method
 * `Error` messages, so it falls back to `Error`/string/JSON rendering for
 * anything that isn't a recognized host error payload.
 *
 * Used by {@link HostCallFailedError} to render its message, and by the throwing
 * adapter-method helper `unwrapHostResult`.
 */
export function formatHostError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;

    if (isHostErrorPayload(error)) {
        if ("tag" in error) {
            // Tagged variant carrying a reason: { tag, value: { reason } }
            if (error.value != null && typeof error.value.reason === "string") {
                return `${error.tag}: ${error.value.reason}`;
            }
            // Unit tagged variant, e.g. { tag: "Full" } / { tag: "PermissionDenied" }
            return error.tag;
        }
        // GenericError: { reason }
        return error.reason;
    }

    if (error != null && typeof error === "object" && "message" in error) {
        const message = (error as { message: unknown }).message;
        if (typeof message === "string") return message;
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Base class for all host errors. Use `instanceof HostError` (or {@link isHostError})
 * to catch any host-related failure.
 */
export class HostError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "HostError";
    }
}

/**
 * The host API is not available — the app is running outside a Polkadot host
 * container (no injected TruAPI transport). The dominant case during local
 * development. Branch with `instanceof HostUnavailableError` to surface an
 * "open this app in a Polkadot host" message.
 */
export class HostUnavailableError extends HostError {
    constructor(message = "Host API is not available") {
        super(message);
        this.name = "HostUnavailableError";
    }
}

/**
 * A host call reached the container but failed on the `Err` channel. Wraps the
 * structured truapi {@link HostErrorPayload} as {@link payload} (also preserved
 * as `cause`); the message is rendered via {@link formatHostError}.
 */
export class HostCallFailedError extends HostError {
    readonly payload: HostErrorPayload;

    constructor(label: string, payload: HostErrorPayload) {
        super(`${label}: ${formatHostError(payload)}`, { cause: payload });
        this.name = "HostCallFailedError";
        this.payload = payload;
    }
}

/** Check whether a value is any {@link HostError}. */
export function isHostError(error: unknown): error is HostError {
    return error instanceof HostError;
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("host error classes", () => {
        test("HostError is the base class", () => {
            const e = new HostUnavailableError();
            expect(e).toBeInstanceOf(HostError);
            expect(e).toBeInstanceOf(Error);
        });

        test("HostUnavailableError default message", () => {
            const e = new HostUnavailableError();
            expect(e.name).toBe("HostUnavailableError");
            expect(e.message).toBe("Host API is not available");
        });

        test("HostUnavailableError custom message", () => {
            expect(new HostUnavailableError("nope").message).toBe("nope");
        });

        test("HostCallFailedError renders payload and preserves it", () => {
            const payload = { tag: "PermissionDenied", value: { reason: "user said no" } };
            const e = new HostCallFailedError("requestPermission failed", payload);
            expect(e).toBeInstanceOf(HostError);
            expect(e.payload).toBe(payload);
            expect(e.cause).toBe(payload);
            expect(e.message).toBe("requestPermission failed: PermissionDenied: user said no");
        });

        test("HostCallFailedError renders a GenericError payload", () => {
            const e = new HostCallFailedError("submit failed", { reason: "timeout" });
            expect(e.message).toBe("submit failed: timeout");
        });

        test("isHostError narrows host errors only", () => {
            expect(isHostError(new HostUnavailableError())).toBe(true);
            expect(isHostError(new HostCallFailedError("x", { reason: "y" }))).toBe(true);
            expect(isHostError(new Error("plain"))).toBe(false);
            expect(isHostError("string")).toBe(false);
        });
    });

    describe("formatHostError", () => {
        test("renders the TruAPI error payload shapes", () => {
            // GenericError: { reason }
            expect(formatHostError({ reason: "boom" })).toBe("boom");
            // Tagged variant carrying a reason: { tag, value: { reason } }
            expect(formatHostError({ tag: "Unknown", value: { reason: "boom" } })).toBe(
                "Unknown: boom",
            );
            // Unit tagged variant: { tag }
            expect(formatHostError({ tag: "Full" })).toBe("Full");
        });

        test("falls back for non-host-error input", () => {
            expect(formatHostError(new Error("plain"))).toBe("plain");
            expect(formatHostError("string err")).toBe("string err");
            expect(formatHostError({ message: "loose" })).toBe("loose");
        });
    });
}
