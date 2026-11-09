// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SdkError } from "@parity/product-sdk-errors";

/**
 * Why a profile read or write failed. The first three are the reasons a
 * record is refused as not a profile. The DotNS walk in `getProfile` and
 * `prepareSetProfile` reports through `DotNsError` instead.
 */
export type ProfileErrorReason =
    | "NotBase64" // the record text is not standard base64 with padding
    | "TooLarge" // a record over the 16 KiB bound, or an avatar over 2 MiB
    | "Malformed" // not exactly one SCALE ProfileRecord
    | "InvalidEntry" // a patch value no entry can carry: a bad CID, name, topic or signer
    | "Host" // a host call failed, or answered something unusable: an avatar keyed by something other than its digest, a proof no reader accepts; the cause is attached
    | "SignerMismatch" // the host signs moods as a key the record's feed does not name: publish from this product first
    | "Timeout"; // a host call or the mood feed's backfill ran out of time; a store or submit may still complete, so word a retry as such

/** Base class for profile errors. Implements the cross-package {@link SdkError} marker. */
export class ProfileError extends Error implements SdkError {
    readonly isSdkError = true as const;
    readonly source = "profile";
    readonly reason: ProfileErrorReason;

    constructor(reason: ProfileErrorReason, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ProfileError";
        this.reason = reason;
    }
}

/**
 * A host call that threw, as a {@link ProfileError} with the cause attached:
 * `Timeout` when the host's deadline passed, which the call may still
 * outlive (an avatar stored, a mood submitted), and `Host` for any other
 * failure. The deadline is a `HostTimeoutError` from `/host` anywhere on the
 * cause chain, matched by name: this module imports no host code at runtime,
 * and a host may bundle its own copy of the class.
 */
export function hostCallFailed(message: string, cause: unknown): ProfileError {
    return new ProfileError(timedOut(cause) ? "Timeout" : "Host", message, { cause });
}

/** Whether `error` or a cause under it is a `HostTimeoutError`. Bounded, so a cyclic chain ends. */
function timedOut(error: unknown): boolean {
    let e = error;
    for (let depth = 0; depth < 8 && e instanceof Error; depth++, e = e.cause) {
        if (e.name === "HostTimeoutError") return true;
    }
    return false;
}
