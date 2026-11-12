// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { formatBalance } from "@parity/product-sdk-hooks-core";
import { type ComputedRef, computed } from "vue";
import { type MaybeGetter, toGetter } from "../internal.js";

export interface FormatBalanceOptions {
    decimals?: number;
    maxDecimals?: number;
    symbol?: string;
    locale?: string;
}

/** Format a planck bigint for display, reactively. */
export function useFormattedBalance(
    planck: MaybeGetter<bigint | undefined | null>,
    options?: FormatBalanceOptions,
): ComputedRef<string> {
    const getPlanck = toGetter(planck);
    return computed(() => {
        const value = getPlanck();
        if (value === undefined || value === null) return "";
        return formatBalance(value, options);
    });
}
