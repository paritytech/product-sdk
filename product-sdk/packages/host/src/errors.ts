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
import { createLogger } from "@parity/product-sdk-logger";
import { ConnectionResetError, RequestTimeoutError, type scale } from "@parity/truapi";

const log = createLogger("host");

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

/**
 * A host call could not be processed to completion: the `ResultAsync` the
 * truapi client returns rejected instead of resolving to an ok/err. The usual
 * cause is a response the client's SCALE codec can't decode (a
 * `RangeError: Offset is outside the bounds of the DataView`) because the host
 * and the `@parity/truapi` version the product is built against disagree on the
 * wire shape of that call — a protocol-version skew. A host channel that closed
 * mid-call looks identical from here, so this does not assert the skew; the
 * real error is preserved on {@link cause}. A call the host never answers is
 * the {@link HostTimeoutError} subclass, whose message says so.
 *
 * The truapi client catches the decode throw in its message handler and turns
 * it into a promise rejection, then wraps the call with
 * `ResultAsync.fromSafePromise`, which installs no rejection handler — so the
 * rejection escapes the `Result` channel rather than landing on its err side.
 * Without this boundary that surfaces as a raw `RangeError` with a stack naming
 * neither the call nor the cause. This names the call, so a bug report has
 * somewhere to start.
 */
export class HostResponseDecodeError extends HostError {
    /** The host-API call whose response failed to decode, e.g. `"createRingVRFProof"`. */
    readonly call: string;

    constructor(call: string, cause: unknown) {
        super(
            `Could not process the host's response to ${call}: ${formatHostError(cause)}. The usual cause is a protocol-version skew between the host app and the @parity/truapi version this product is built against; a host channel that closed mid-call looks the same.`,
            { cause },
        );
        this.name = "HostResponseDecodeError";
        this.call = call;
    }
}

/**
 * A host call got no answer before the truapi client's deadline. The client
 * asks the host to cancel the call, but the host may already have acted on it,
 * for example a person approving on their phone, so check the outcome before
 * retrying. The client's {@link RequestTimeoutError} is preserved on
 * {@link cause}.
 *
 * It is a {@link HostResponseDecodeError}, so code that handles a call the
 * client could not complete handles a timeout too, but its message does not
 * blame a protocol-version skew.
 */
export class HostTimeoutError extends HostResponseDecodeError {
    /** How long the client waited, in milliseconds. */
    readonly timeoutMs: number;

    constructor(call: string, cause: RequestTimeout) {
        super(call, cause);
        this.message = `The host did not answer ${call} within ${formatWait(cause.timeoutMs)}.`;
        this.name = "HostTimeoutError";
        this.timeoutMs = cause.timeoutMs;
    }
}

/** The shape of the truapi client's {@link RequestTimeoutError} this package relies on. */
type RequestTimeout = Error & { timeoutMs: number };

/**
 * Whether `cause` is the truapi client's {@link RequestTimeoutError}. Matched
 * by name, not `instanceof`: a host may inject a client bundled with its own
 * copy of `@parity/truapi`.
 */
function isRequestTimeout(cause: unknown): cause is RequestTimeout {
    return (
        cause instanceof Error &&
        cause.name === "RequestTimeoutError" &&
        typeof (cause as { timeoutMs?: unknown }).timeoutMs === "number"
    );
}

/**
 * Whether `cause` is the {@link ConnectionResetError} of the truapi client,
 * matched by name for the same reason as {@link isRequestTimeout}.
 */
function isConnectionReset(cause: unknown): cause is Error {
    return cause instanceof Error && cause.name === "ConnectionResetError";
}

function formatWait(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * The typed error for a host call whose `ResultAsync` rejected: a
 * {@link HostTimeoutError} when the client's deadline passed, otherwise a
 * {@link HostResponseDecodeError}. One already typed passes through.
 *
 * A call that a reset of the host link rejected is logged at warn, with the
 * reason the link closed, so the app log shows which calls the drop cost.
 *
 * @internal
 */
export function hostRejectionError(call: string, cause: unknown): HostResponseDecodeError {
    if (cause instanceof HostResponseDecodeError) return cause;
    if (isConnectionReset(cause)) {
        const closeReason = cause.cause === undefined ? "" : ` (${formatHostError(cause.cause)})`;
        log.warn(`${call}: the host link was reset mid-call${closeReason}`);
    }
    return isRequestTimeout(cause)
        ? new HostTimeoutError(call, cause)
        : new HostResponseDecodeError(call, cause);
}

/** Check whether a value is any {@link HostError}. */
export function isHostError(error: unknown): error is HostError {
    return error instanceof HostError;
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");

    function captureHostLog(): string[] {
        const lines: string[] = [];
        configure({
            level: "warn",
            handler: (entry) => lines.push(`${entry.level}: ${entry.message}`),
        });
        return lines;
    }

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

        test("HostResponseDecodeError names the call, interpolates the cause, and preserves it", () => {
            const cause = new RangeError("Offset is outside the bounds of the DataView");
            const e = new HostResponseDecodeError("createRingVRFProof", cause);
            expect(e).toBeInstanceOf(HostError);
            expect(e.name).toBe("HostResponseDecodeError");
            expect(e.call).toBe("createRingVRFProof");
            expect(e.cause).toBe(cause);
            expect(e.message).toContain("createRingVRFProof");
            // The rendered cause is in the message, not just on `.cause`.
            expect(e.message).toContain("Offset is outside the bounds of the DataView");
            expect(e.message).toContain("protocol-version skew");
        });

        test("HostTimeoutError names the call and the wait, and keeps the client's error", () => {
            const cause = new RequestTimeoutError("p:17", 12, 0, 390_000);
            const error = new HostTimeoutError("requestResourceAllocation", cause);
            // Code that handles a decode error keeps handling a timeout.
            expect({
                isDecodeError: error instanceof HostResponseDecodeError,
                error,
            }).toMatchObject({
                isDecodeError: true,
                error: {
                    name: "HostTimeoutError",
                    call: "requestResourceAllocation",
                    timeoutMs: 390_000,
                    message: "The host did not answer requestResourceAllocation within 390s.",
                    cause,
                },
            });
        });

        test("hostRejectionError tells a timeout from a decode failure", () => {
            // A client bundled with its own copy of `@parity/truapi` throws
            // another class with the same name and shape.
            const bundledTimeout = Object.assign(new Error("timed out"), {
                name: "RequestTimeoutError",
                timeoutMs: 500,
            });
            const causes = [
                new RequestTimeoutError("p:1", 12, 0, 120_000),
                bundledTimeout,
                new RangeError("Offset is outside the bounds of the DataView"),
            ];
            expect(
                causes.map((cause) => {
                    const error = hostRejectionError("signRaw", cause);
                    return error instanceof HostTimeoutError ? error.message : error.name;
                }),
            ).toEqual([
                "The host did not answer signRaw within 120s.",
                "The host did not answer signRaw within 500ms.",
                "HostResponseDecodeError",
            ]);
        });

        test("a call the reset rejected is logged at warn with its label and the close reason", () => {
            const lines = captureHostLog();
            const closed = new Error("websocket closed (ws://127.0.0.1:9955)");
            const reset = new ConnectionResetError({ cause: closed });
            const bundledReset = Object.assign(new Error("TrUAPI host connection interrupted"), {
                name: "ConnectionResetError",
                cause: closed,
            });

            hostRejectionError("createTransaction failed", reset);
            hostRejectionError("signRaw failed", bundledReset);
            hostRejectionError("getUserId", new ConnectionResetError());

            expect(lines).toEqual([
                "warn: createTransaction failed: the host link was reset mid-call (websocket closed (ws://127.0.0.1:9955))",
                "warn: signRaw failed: the host link was reset mid-call (websocket closed (ws://127.0.0.1:9955))",
                "warn: getUserId: the host link was reset mid-call",
            ]);
        });

        test("a timeout, a decode failure or an already typed rejection is not logged", () => {
            const lines = captureHostLog();
            const causes = [
                new RequestTimeoutError("p:1", 12, 0, 120_000),
                new RangeError("Offset is outside the bounds of the DataView"),
                new HostResponseDecodeError("getUserId", new ConnectionResetError()),
            ];

            for (const cause of causes) hostRejectionError("getUserId", cause);

            expect(lines).toEqual([]);
        });

        test("isHostError narrows host errors only", () => {
            expect(isHostError(new HostUnavailableError())).toBe(true);
            expect(isHostError(new HostCallFailedError("x", { tag: "Denied" }))).toBe(true);
            expect(isHostError(new HostResponseDecodeError("c", new Error("boom")))).toBe(true);
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
