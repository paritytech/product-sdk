// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SdkError } from "@parity/product-sdk-errors";

/** Base class for reputation errors. Implements the shared {@link SdkError} marker. */
export class ReputationError extends Error implements SdkError {
    readonly isSdkError = true as const;
    readonly source = "reputation";

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ReputationError";
    }
}

/** A request contains an invalid ID, address, or value. */
export class ReputationInputError extends ReputationError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ReputationInputError";
    }
}

/** Contract output, an event, or a chain value does not match its expected shape. */
export class ReputationDecodeError extends ReputationError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ReputationDecodeError";
    }
}

/** A contract query failed. Retains the operation and raw failure in `detail`. */
export class ReputationQueryError extends ReputationError {
    readonly operation: string;
    readonly detail: unknown;

    constructor(operation: string, detail: unknown) {
        super(`${operation} failed.`, { cause: detail });
        this.name = "ReputationQueryError";
        this.operation = operation;
        this.detail = detail;
    }
}
