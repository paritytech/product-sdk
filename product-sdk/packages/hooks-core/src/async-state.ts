// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
export type AsyncStatus = "idle" | "loading" | "success" | "error";

export interface AsyncState<T, E = Error> {
    status: AsyncStatus;
    /** Last successful value; kept during reloads so UIs don't flash empty. */
    data: T | undefined;
    error: E | undefined;
}

export const asyncIdle = <T, E = Error>(): AsyncState<T, E> => ({
    status: "idle",
    data: undefined,
    error: undefined,
});

export const asyncLoading = <T, E = Error>(prev?: AsyncState<T, E>): AsyncState<T, E> => ({
    status: "loading",
    data: prev?.data,
    error: undefined,
});

export const asyncSuccess = <T, E = Error>(data: T): AsyncState<T, E> => ({
    status: "success",
    data,
    error: undefined,
});

export const asyncError = <T, E = Error>(error: E, prev?: AsyncState<T, E>): AsyncState<T, E> => ({
    status: "error",
    data: prev?.data,
    error,
});

/** Normalize any thrown value into an Error without losing the original. */
export function toError(value: unknown): Error {
    if (value instanceof Error) return value;
    return new Error(typeof value === "string" ? value : JSON.stringify(value), { cause: value });
}
