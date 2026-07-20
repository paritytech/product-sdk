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
 * This module also owns {@link HostErrorPayload} (the domain-error payload
 * shape), {@link HostWireError} / {@link toHostErrorPayload} (the truapi ≥0.4
 * `CallError` envelope and its central unwrap), and {@link formatHostError}
 * (renders a payload to a message) — co-located with the error classes that
 * consume them so the host error model lives in one place.
 *
 * @module
 */
import type { SdkError } from "@parity/product-sdk-errors";
import type { GenericError } from "@parity/truapi";
import type { CallErrorValue } from "@parity/truapi/scale";

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

// ─────────────────────────────────────────────────────────────────────────────
// truapi ≥0.4 `CallError` envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The error channel of every truapi ≥0.4 generated method: the framework
 * `CallError` envelope around the *versioned* domain error. `Domain` carries
 * the method's real domain error (inside its generated `Versioned*` wrapper,
 * `{ tag: "V1", value }`); the other variants are framework-level failures
 * (`Denied` / `Unsupported` / `MalformedFrame` / `HostFailure`) that in truapi
 * 0.3.x would never have reached the `Err` channel at all.
 */
export type HostWireError = CallErrorValue<{ tag: string; value: unknown }>;

/** Framework (non-`Domain`) tags of truapi's `CallErrorValue` envelope. */
const CALL_ERROR_FRAMEWORK_TAGS = new Set([
    "Denied",
    "Unsupported",
    "MalformedFrame",
    "HostFailure",
]);

/** Narrow an unknown `Err`-channel value to a truapi `CallErrorValue` envelope. */
function isCallErrorValue(error: unknown): error is CallErrorValue<unknown> {
    if (error == null || typeof error !== "object") return false;
    const tag = (error as { tag?: unknown }).tag;
    if (typeof tag !== "string") return false;
    if (tag === "Domain") return "value" in error;
    return CALL_ERROR_FRAMEWORK_TAGS.has(tag);
}

/** Unwrap a generated `Versioned*` envelope (`{ tag: "V1", value }`) if present. */
function unwrapVersioned(value: unknown): unknown {
    if (value == null || typeof value !== "object") return value;
    const envelope = value as { tag?: unknown; value?: unknown };
    if (typeof envelope.tag === "string" && /^V\d+$/.test(envelope.tag) && "value" in envelope) {
        return envelope.value;
    }
    return value;
}

/**
 * Collapse a truapi error-channel value to the {@link HostErrorPayload} worth
 * carrying/reporting. truapi ≥0.4 wraps every generated method's error in a
 * `CallErrorValue` envelope ({@link HostWireError}): `Domain` unwraps to the
 * real domain error (its `Versioned*` wrapper removed), and the framework
 * variants pass through as payloads (they already render as `"Denied"` /
 * `"MalformedFrame: reason"` shapes). Non-envelope values — bare 0.3.x-style
 * domain payloads, hand-fed test errors — pass through unchanged, so
 * {@link HostErrorPayload} stays the *domain* payload type.
 */
export function toHostErrorPayload(error: unknown): HostErrorPayload {
    if (isCallErrorValue(error)) {
        if (error.tag === "Domain") {
            return unwrapVersioned((error as { value: unknown }).value) as HostErrorPayload;
        }
        return error as HostErrorPayload;
    }
    return unwrapVersioned(error) as HostErrorPayload;
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

    // truapi ≥0.4 `CallError` envelope: `Domain` renders as the domain error it
    // carries (never as the literal "Domain"); the framework variants fall
    // through to the payload path below ("Denied", "MalformedFrame: reason", …).
    if (isCallErrorValue(error) && error.tag === "Domain") {
        return formatHostError(unwrapVersioned((error as { value: unknown }).value));
    }
    // A generated `Versioned*` envelope ({ tag: "V1", value }) renders as its inner value.
    const unwrapped = unwrapVersioned(error);
    if (unwrapped !== error) return formatHostError(unwrapped);

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
 * to catch any host-related failure. Implements the cross-package
 * {@link SdkError} marker so `isSdkError(e)` also recognizes it.
 */
export class HostError extends Error implements SdkError {
    readonly isSdkError = true as const;
    readonly source = "host";

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

        test("unwraps the truapi >=0.4 CallError envelope (never prints 'Domain')", () => {
            // Domain, carrying the generated Versioned wrapper around the domain error.
            expect(
                formatHostError({
                    tag: "Domain",
                    value: { tag: "V1", value: { tag: "NotConnected" } },
                }),
            ).toBe("NotConnected");
            // Domain around a versioned reason-carrying variant.
            expect(
                formatHostError({
                    tag: "Domain",
                    value: { tag: "V1", value: { tag: "Unknown", value: { reason: "boom" } } },
                }),
            ).toBe("Unknown: boom");
            // Domain around a versioned plain-string domain error (e.g. CoinPaymentError).
            expect(
                formatHostError({ tag: "Domain", value: { tag: "V1", value: "BalanceLow" } }),
            ).toBe("BalanceLow");
            // Framework variants render as tag / tag: reason.
            expect(formatHostError({ tag: "Denied" })).toBe("Denied");
            expect(formatHostError({ tag: "Unsupported" })).toBe("Unsupported");
            expect(formatHostError({ tag: "MalformedFrame", value: { reason: "bad bytes" } })).toBe(
                "MalformedFrame: bad bytes",
            );
            expect(formatHostError({ tag: "HostFailure", value: { reason: "panicked" } })).toBe(
                "HostFailure: panicked",
            );
            // A bare Versioned envelope renders as its inner value, not "V1".
            expect(formatHostError({ tag: "V1", value: { tag: "Rejected" } })).toBe("Rejected");
        });
    });

    describe("toHostErrorPayload", () => {
        test("Domain unwraps to the bare domain error", () => {
            expect(
                toHostErrorPayload({
                    tag: "Domain",
                    value: { tag: "V1", value: { tag: "Rejected" } },
                }),
            ).toEqual({ tag: "Rejected" });
        });

        test("framework variants pass through as payloads", () => {
            expect(toHostErrorPayload({ tag: "Denied" })).toEqual({ tag: "Denied" });
            expect(toHostErrorPayload({ tag: "HostFailure", value: { reason: "x" } })).toEqual({
                tag: "HostFailure",
                value: { reason: "x" },
            });
        });

        test("bare 0.3.x-style payloads pass through unchanged", () => {
            expect(toHostErrorPayload({ reason: "boom" })).toEqual({ reason: "boom" });
            expect(toHostErrorPayload({ tag: "Full" })).toEqual({ tag: "Full" });
        });
    });
}
