// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SdkError } from "@parity/product-sdk-errors";

/**
 * Why a profile read failed.
 *
 * The first three come from `decodeProfileRecord` and match the core's
 * `ProfileRecordError` plus its base64 check: `NotBase64` is text that is not
 * standard base64 with padding, `TooLarge` is a record over the 16 KiB bound,
 * refused before parsing, `Malformed` is anything that is not exactly one
 * SCALE `ProfileRecord`. `ChainRead` is a chain read in `getPinnedNfts` that
 * failed, the display read made through the nfts package or the owner read
 * made there, with the underlying error as `cause`. The dotNS walk in
 * `getProfile` reports through `DotNsError`.
 */
export type ProfileErrorReason = "NotBase64" | "TooLarge" | "Malformed" | "ChainRead";

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
