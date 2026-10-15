// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { formatBalance } from "@parity/product-sdk-hooks-core";
import { useMemo } from "react";

export interface FormatBalanceOptions {
    decimals?: number;
    maxDecimals?: number;
    symbol?: string;
    locale?: string;
}

/** Format a planck bigint for display, memoized. */
export function useFormattedBalance(
    planck: bigint | undefined | null,
    options?: FormatBalanceOptions,
): string {
    const { decimals, maxDecimals, symbol, locale } = options ?? {};
    return useMemo(() => {
        if (planck === undefined || planck === null) return "";
        return formatBalance(planck, { decimals, maxDecimals, symbol, locale });
    }, [planck, decimals, maxDecimals, symbol, locale]);
}
