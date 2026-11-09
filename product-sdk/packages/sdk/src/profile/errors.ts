// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SdkError } from "@parity/product-sdk-errors";

/**
 * Why a profile read or write failed. The first three match the core's
 * `ProfileRecordError` plus its base64 check. The dotNS walk in `getProfile`
 * and `prepareSetProfile` reports through `DotNsError` instead.
 */
export type ProfileErrorReason =
    | "NotBase64" // the record text is not standard base64 with padding
    | "TooLarge" // a record over the 16 KiB bound, or an avatar over 2 MiB
    | "Malformed" // not exactly one SCALE ProfileRecord
    | "InvalidEntry" // a patch value no entry can carry: a bad CID, name, topic or signer
    | "Host" // a host call failed, or answered something unusable: an avatar keyed by something other than its digest, a proof no reader accepts; the cause is attached
    | "SignerMismatch" // the host signs moods as a key the record's feed does not name: publish from this product first
    | "Timeout"; // the mood feed's backfill did not finish in time

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
