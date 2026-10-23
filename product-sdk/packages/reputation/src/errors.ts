// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { SdkError } from "@parity/product-sdk-errors";

export class ReputationError extends Error implements SdkError {
    readonly isSdkError = true as const;
    readonly source = "reputation";

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ReputationError";
    }
}

export class ReputationInputError extends ReputationError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ReputationInputError";
    }
}

export class ReputationDecodeError extends ReputationError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ReputationDecodeError";
    }
}

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
