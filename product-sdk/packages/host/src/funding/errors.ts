// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Errors a funding provider's session raises, and how a host error is
 * classified for retrying.
 *
 * @module
 */
import type { FundingFailure, FundingUpdate } from "@parity/truapi";

import {
    HostCallFailedError,
    HostError,
    HostResponseDecodeError,
    HostUnavailableError,
} from "../errors.js";

/** Base class of the errors a funding session raises. Catch with `instanceof`. */
export class FundingProviderError extends HostError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "FundingProviderError";
    }
}

/**
 * Ends a session as `Failed { reason }`. Thrown by `session.fail(…)`;
 * `serveFunding` reports the failure when it reaches the session's end.
 */
export class FundingFailed extends FundingProviderError {
    readonly reason: FundingFailure;

    constructor(reason: FundingFailure) {
        super(`funding session failed: ${reason.tag}`);
        this.name = "FundingFailed";
        this.reason = reason;
    }
}

/** The host no longer serves the session to this provider: it ended, or it is not this provider's. */
export class SessionOverError extends FundingProviderError {
    constructor(intent: string, options?: ErrorOptions) {
        super(`funding session ${intent} is over`, options);
        this.name = "SessionOverError";
    }
}

/** The encoded saved state is larger than the host keeps for a session. */
export class StateTooLargeError extends FundingProviderError {
    readonly size: number;
    readonly max: number;

    constructor(size: number, max: number) {
        super(`saved state is ${size} bytes, over the host's ${max}`);
        this.name = "StateTooLargeError";
        this.size = size;
        this.max = max;
    }
}

/**
 * The host refused a report as out of order or as naming funds it never saw
 * start. Either way the provider reported something the core's rules do not
 * allow, which retrying cannot fix.
 */
export class ReportRefusedError extends FundingProviderError {
    readonly tag: "OutOfOrder" | "NotStarted";
    readonly update: FundingUpdate["tag"];

    constructor(tag: "OutOfOrder" | "NotStarted", update: FundingUpdate["tag"]) {
        super(`the host refused ${update} as ${tag}`);
        this.name = "ReportRefusedError";
        this.tag = tag;
        this.update = update;
    }
}

/** The host refused a top-up: its source is malformed or unknown, or its amount is zero. */
export class TopUpRefusedError extends FundingProviderError {
    readonly tag: "InvalidSource" | "InvalidAmount";

    constructor(tag: "InvalidSource" | "InvalidAmount") {
        super(`the host refused the top-up as ${tag}`);
        this.name = "TopUpRefusedError";
        this.tag = tag;
    }
}

/** The host refused a payment request: the user rejected it, cannot cover it, or its amount is zero. */
export class PaymentRefusedError extends FundingProviderError {
    readonly tag: "Rejected" | "InsufficientBalance" | "InvalidAmount";

    constructor(tag: "Rejected" | "InsufficientBalance" | "InvalidAmount") {
        super(`the host refused the payment as ${tag}`);
        this.name = "PaymentRefusedError";
        this.tag = tag;
    }
}

/** A wait or call stopped because its `AbortSignal` fired. */
export class FundingAbortedError extends FundingProviderError {
    constructor(what = "funding operation") {
        super(`${what} was aborted`);
        this.name = "FundingAbortedError";
    }
}

/**
 * The innermost tag of a host call error: the domain error's tag for a
 * `Domain` failure (such as `"OutOfOrder"`), otherwise the transport tag
 * (`Denied`, `Unsupported`, `MalformedFrame`, `HostFailure`).
 */
export function hostErrorTag(error: unknown): string | undefined {
    if (!(error instanceof HostCallFailedError)) return undefined;
    const payload = error.payload as { tag: string; value?: unknown };
    if (payload.tag !== "Domain") return payload.tag;
    const versioned = payload.value as { tag?: string; value?: { tag?: string } } | undefined;
    return versioned?.value?.tag ?? versioned?.tag;
}

/** Domain refusals: the host answered, and asking again gets the same answer. */
const REFUSALS = new Set([
    "AlreadyExists",
    "InsufficientBalance",
    "InvalidAmount",
    "InvalidSource",
    "InvalidUrl",
    "NotFound",
    "NotStarted",
    "OutOfOrder",
    "PermissionDenied",
    "Rejected",
    "TooLarge",
]);

/** Transport failures that mean the host will not serve the call at all. */
const UNSERVED = new Set(["Denied", "Unsupported", "MalformedFrame"]);

/**
 * Whether retrying the call that raised `error` can help.
 *
 * - A host refusal (`OutOfOrder`, `AlreadyExists`, `Rejected`, …), a call the
 *   host does not serve (`Denied`, `Unsupported`, `MalformedFrame`), a
 *   response this build cannot decode, a missing host, a funding session
 *   error and a programming error (`TypeError`, `RangeError`, …) are not.
 * - A host failure (`HostFailure`, `Unknown`, `SourceBusy`, a top-up or payment
 *   the host has not seen yet) and anything else, such as a network error
 *   from the provider's own API, is.
 */
export function isTransient(error: unknown): boolean {
    if (error instanceof HostCallFailedError) {
        const tag = hostErrorTag(error);
        return tag === undefined || !(REFUSALS.has(tag) || UNSERVED.has(tag));
    }
    if (
        error instanceof HostResponseDecodeError ||
        error instanceof HostUnavailableError ||
        error instanceof FundingProviderError
    ) {
        return false;
    }
    return !(
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof ReferenceError ||
        error instanceof SyntaxError
    );
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    const domain = (tag: string) =>
        new HostCallFailedError("call", {
            tag: "Domain",
            value: { tag: "V1", value: { tag } },
        } as never);

    describe("hostErrorTag", () => {
        test("reads the domain error's tag through the version envelope", () => {
            expect(hostErrorTag(domain("OutOfOrder"))).toBe("OutOfOrder");
        });

        test("reads a transport failure's own tag", () => {
            expect(hostErrorTag(new HostCallFailedError("call", { tag: "Denied" } as never))).toBe(
                "Denied",
            );
        });

        test("is undefined for anything but a host call failure", () => {
            expect(hostErrorTag(new Error("x"))).toBeUndefined();
        });
    });

    describe("isTransient", () => {
        test.each([
            ["OutOfOrder", false],
            ["AlreadyExists", false],
            ["NotFound", false],
            ["SourceBusy", true],
            ["TopUpNotFound", true],
            ["PaymentNotFound", true],
            ["Unknown", true],
        ])("a %s refusal is transient: %s", (tag, transient) => {
            expect(isTransient(domain(tag))).toBe(transient);
        });

        test("transport failures", () => {
            const failure = (tag: string) => new HostCallFailedError("c", { tag } as never);
            expect(isTransient(failure("HostFailure"))).toBe(true);
            expect(isTransient(failure("Denied"))).toBe(false);
            expect(isTransient(failure("Unsupported"))).toBe(false);
        });

        test("decode failures, session errors and bugs are not transient", () => {
            expect(isTransient(new HostResponseDecodeError("c", new RangeError("x")))).toBe(false);
            expect(isTransient(new SessionOverError("i"))).toBe(false);
            expect(isTransient(new TypeError("x"))).toBe(false);
        });

        test("any other error, such as the provider's own API failing, is", () => {
            expect(isTransient(new Error("fetch failed"))).toBe(true);
        });
    });
}
