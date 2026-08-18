// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SdkError } from "@parity/product-sdk-errors";

/**
 * Error on the `Err` channel of a DotNS registry read/write. Implements the
 * cross-package {@link SdkError} marker so `isSdkError(e)` recognizes it.
 *
 * `reason` distinguishes the failure kind so callers can branch without string
 * matching. `NotWired` is temporary — see {@link DotNsError} usage in
 * `dotns-registry.ts`; it goes away once the registry ABI is wired in.
 */
export type DotNsErrorReason =
    | "NotWired" // registry ABI not yet configured (implementation pending)
    | "InvalidName" // name failed isValidDotNsName
    | "MissingOrigin" // a write was requested without the submitting account
    | "NameReserved" // governance-held, or a base stem held by another user
    | "OwnerStatusInsufficient" // the owner lacks the personhood tier the label requires
    | "RegistryCall" // the on-chain contract call failed
    | "Decode"; // the contract returned something we couldn't decode

export class DotNsError extends Error implements SdkError {
    readonly isSdkError = true as const;
    readonly source = "dotns";
    readonly reason: DotNsErrorReason;

    constructor(reason: DotNsErrorReason, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "DotNsError";
        this.reason = reason;
    }
}
