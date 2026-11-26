// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The slice of the TruAPI client a funding provider uses, and the call
 * helper that turns a host answer into a value or a typed error.
 *
 * @module
 */
import type { TrUApiClient } from "@parity/truapi";

import type { HostErrorPayload } from "../errors.js";
import { mapHostResult, type ResultAsync } from "../truapi.js";

/** The public surface of a generated domain client, which a plain object can implement. */
type PublicSurface<C> = { [K in keyof C]: C[K] };

/**
 * The domains a funding provider calls: `fundingProvider`, `payment`,
 * `localStorage`, `entropy` and `worker`. A test passes its own, such as the
 * fake from `@parity/product-sdk-host/testing`.
 */
export type FundingClient = {
    [D in "fundingProvider" | "payment" | "localStorage" | "entropy" | "worker"]: PublicSurface<
        TrUApiClient[D]
    >;
};

/**
 * Await a host call and return its value, or throw a `HostCallFailedError`
 * carrying the host's error (or a `HostResponseDecodeError` when the answer
 * does not decode).
 */
export async function call<T>(
    result: ResultAsync<T, HostErrorPayload> | ResultAsync<T, unknown>,
    label: string,
): Promise<T> {
    const folded = await mapHostResult(
        result as ResultAsync<T, HostErrorPayload>,
        (value) => value,
        label,
    );
    if (!folded.ok) throw folded.error;
    return folded.value;
}
