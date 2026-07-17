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
import type { SdkError } from "@parity/product-sdk-errors";
import type { scale } from "@parity/truapi";

/**
 * What a `Domain`-tagged call error carries. Widened from truapi's per-domain
 * `Versioned*Error` types (all `{ tag: "V1", value: <domain error> }` today)
 * so one payload type covers every call.
 */
type VersionedDomainError = { tag: string; value?: unknown };

/**
 * The error a host call puts on its `Err` channel — truapi's canonical
 * {@link scale.CallErrorValue} envelope. `Denied` / `Unsupported` /
 * `MalformedFrame` / `HostFailure` are transport-level failures; `Domain`
 * wraps the actual per-domain error in a versioned envelope, which
 * {@link formatHostError} digs through when rendering.
 *
 * This is the payload {@link HostCallFailedError} carries — not the error
 * type consumers branch on.
 */
export type HostErrorPayload = scale.CallErrorValue<VersionedDomainError>;

/** Narrow to a tagged-union member: `{ tag, value? }`. */
function isTagged(value: unknown): value is { tag: string; value?: unknown } {
    return (
        value != null &&
        typeof value === "object" &&
        typeof (value as { tag?: unknown }).tag === "string"
    );
}

/** Narrow to a reason-carrying payload — truapi's `GenericError` shape. */
function hasReason(value: unknown): value is { reason: string } {
    return (
        value != null &&
        typeof value === "object" &&
        typeof (value as { reason?: unknown }).reason === "string"
    );
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

    if (isTagged(error)) {
        // `Domain` carries the real error inside a versioned envelope — unwrap it.
        if (error.tag === "Domain" && isTagged(error.value) && error.value.value !== undefined) {
            return formatHostError(error.value.value);
        }
        // Tagged variant carrying a reason: { tag, value: { reason } }
        if (hasReason(error.value)) {
            return `${error.tag}: ${error.value.reason}`;
        }
        // Unit tagged variant, e.g. { tag: "Denied" } / { tag: "PermissionDenied" }
        return error.tag;
    }
    // GenericError: { reason }
    if (hasReason(error)) {
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
            const payload: HostErrorPayload = {
                tag: "Domain",
                value: {
                    tag: "V1",
                    value: { tag: "PermissionDenied", value: { reason: "user said no" } },
                },
            };
            const e = new HostCallFailedError("requestPermission failed", payload);
            expect(e).toBeInstanceOf(HostError);
            expect(e.payload).toBe(payload);
            expect(e.cause).toBe(payload);
            expect(e.message).toBe("requestPermission failed: PermissionDenied: user said no");
        });

        test("HostCallFailedError renders a Domain-wrapped GenericError payload", () => {
            const e = new HostCallFailedError("submit failed", {
                tag: "Domain",
                value: { tag: "V1", value: { reason: "timeout" } },
            });
            expect(e.message).toBe("submit failed: timeout");
        });

        test("isHostError narrows host errors only", () => {
            expect(isHostError(new HostUnavailableError())).toBe(true);
            expect(isHostError(new HostCallFailedError("x", { tag: "Denied" }))).toBe(true);
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

        test("unwraps the CallError Domain envelope to the domain error", () => {
            // { tag: "Domain", value: { tag: "V1", value: <domain error> } }
            expect(
                formatHostError({
                    tag: "Domain",
                    value: { tag: "V1", value: { tag: "PermissionDenied" } },
                }),
            ).toBe("PermissionDenied");
            expect(
                formatHostError({ tag: "Domain", value: { tag: "V1", value: { reason: "boom" } } }),
            ).toBe("boom");
            // Transport-level CallError variants render as-is.
            expect(formatHostError({ tag: "Denied" })).toBe("Denied");
            expect(formatHostError({ tag: "HostFailure", value: { reason: "crashed" } })).toBe(
                "HostFailure: crashed",
            );
        });

        test("falls back for non-host-error input", () => {
            expect(formatHostError(new Error("plain"))).toBe("plain");
            expect(formatHostError("string err")).toBe("string err");
            expect(formatHostError({ message: "loose" })).toBe("loose");
        });
    });
}
