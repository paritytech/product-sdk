// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Answering quote asks: refusals, checking an ask against what the provider
 * serves, and a quote id that carries the terms a quote priced.
 *
 * @module
 */
import type {
    FundingDirection,
    FundingQuote,
    FundingQuoteAnswer,
    FundingQuoteAsk,
    FundingRail,
} from "@parity/truapi";

import { type Result, err, ok } from "../result.js";
import { decodeJson, encodeJson } from "./state.js";

/** Refusals to answer an ask with. */
export const refuse = {
    /** Not offered in the user's country. */
    countryUnsupported(): FundingQuoteAnswer {
        return { tag: "Refused", value: { reason: { tag: "CountryUnsupported" } } };
    },
    /** Below the provider's minimum, in balance units. */
    belowMinimum(min: bigint): FundingQuoteAnswer {
        return { tag: "Refused", value: { reason: { tag: "BelowMinimum", value: { min } } } };
    },
    /** Above the provider's maximum, in balance units. */
    aboveMaximum(max: bigint): FundingQuoteAnswer {
        return { tag: "Refused", value: { reason: { tag: "AboveMaximum", value: { max } } } };
    },
    /** The provider cannot price it now. */
    unavailable(): FundingQuoteAnswer {
        return { tag: "Refused", value: { reason: { tag: "Unavailable" } } };
    },
    /** Any other reason, shown to the user. */
    other(message: string): FundingQuoteAnswer {
        return { tag: "Refused", value: { reason: { tag: "Other", value: { message } } } };
    },
};

/** Answer an ask with the provider's price. */
export function quoted(quote: FundingQuote): FundingQuoteAnswer {
    return { tag: "Quoted", value: { quote } };
}

/** What a provider serves, for {@link validateAsk}. Every field left out allows all. */
export interface AskPolicy {
    /** Directions served. */
    directions?: readonly FundingDirection[];
    /** Per rail, the ISO 3166-1 alpha-2 countries served (any case). */
    countries?: Partial<Record<FundingRail, readonly string[]>>;
    /** Crypto networks served, such as `["polkadot"]`. */
    networks?: readonly string[];
    /** Per rail, the asset symbols taken (In) or paid out (Out), any case. */
    assets?: Partial<Record<FundingRail, readonly string[]>>;
    /** Smallest amount, in balance units. */
    min?: bigint;
    /** Largest amount, in balance units. */
    max?: bigint;
}

const lower = (values: readonly string[]) => values.map((value) => value.toLowerCase());

/**
 * `ok(ask)` when the provider serves it, otherwise `err` with the refusal to
 * answer. Checks direction, country, network, asset, then the limits.
 *
 * @example
 * ```ts
 * onQuote(ask) {
 *     const served = validateAsk(ask, POLICY);
 *     return served.ok ? quoted(price(served.value)) : served.error;
 * }
 * ```
 */
export function validateAsk(
    ask: FundingQuoteAsk,
    policy: AskPolicy,
): Result<FundingQuoteAsk, FundingQuoteAnswer> {
    if (policy.directions && !policy.directions.includes(ask.direction)) {
        return err(refuse.unavailable());
    }
    const countries = policy.countries?.[ask.rail];
    if (countries && !(ask.country && lower(countries).includes(ask.country.toLowerCase()))) {
        return err(refuse.countryUnsupported());
    }
    if (ask.rail === "Crypto" && policy.networks) {
        if (!(ask.network && lower(policy.networks).includes(ask.network.toLowerCase()))) {
            return err(refuse.unavailable());
        }
    }
    const assets = policy.assets?.[ask.rail];
    if (assets && !lower(assets).includes(ask.asset.toLowerCase())) {
        return err(refuse.unavailable());
    }
    if (policy.min !== undefined && ask.amount < policy.min)
        return err(refuse.belowMinimum(policy.min));
    if (policy.max !== undefined && ask.amount > policy.max)
        return err(refuse.aboveMaximum(policy.max));
    return ok(ask);
}

/** The terms a quote priced, which the assignment does not hand back on its own. */
export interface QuoteTerms {
    direction: FundingDirection;
    rail: FundingRail;
    asset: string;
    network?: string;
    /** Balance units. */
    amount: bigint;
    /** Unix ms the price holds until. */
    expiresAt: number;
    /** The provider's own data, such as its quote or order reference. */
    extra?: string;
}

const QUOTE_ID_PREFIX = "pq1.";

/**
 * A quote id that carries its terms. The assignment hands back only the
 * chosen `FundingQuote`, not the rail, asset or network it priced, so a
 * provider puts them in the id it quotes under and reads them back.
 *
 * The id is not authenticated: a provider whose price lives on its own
 * servers should put its own quote or order reference in `extra` and look it
 * up rather than trust the rest.
 */
export const quoteId = {
    encode(terms: QuoteTerms): string {
        return QUOTE_ID_PREFIX + encodeJson(terms).slice(2);
    },
    decode(id: string): Result<QuoteTerms, "foreign" | "malformed"> {
        if (!id.startsWith(QUOTE_ID_PREFIX)) return err("foreign");
        try {
            const terms = decodeJson(`0x${id.slice(QUOTE_ID_PREFIX.length)}`) as QuoteTerms;
            if (typeof terms?.rail !== "string" || typeof terms.amount !== "bigint") {
                return err("malformed");
            }
            return ok(terms);
        } catch {
            return err("malformed");
        }
    },
};

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    const ask = (over: Partial<FundingQuoteAsk> = {}): FundingQuoteAsk => ({
        direction: "In",
        rail: "Card",
        asset: "EUR",
        amount: 50n,
        country: "PT",
        ...over,
    });

    describe("validateAsk", () => {
        const policy: AskPolicy = {
            directions: ["In"],
            countries: { Card: ["pt", "ES"] },
            networks: ["polkadot"],
            assets: { Card: ["EUR"], Crypto: ["USDT"] },
            min: 10n,
            max: 1_000n,
        };

        test("serves an ask inside the policy", () => {
            expect(validateAsk(ask(), policy)).toEqual(ok(ask()));
        });

        test.each([
            ["direction", ask({ direction: "Out" }), refuse.unavailable()],
            ["country", ask({ country: "US" }), refuse.countryUnsupported()],
            ["missing country", ask({ country: undefined }), refuse.countryUnsupported()],
            [
                "network",
                ask({ rail: "Crypto", asset: "USDT", network: "ethereum" }),
                refuse.unavailable(),
            ],
            ["asset", ask({ asset: "GBP" }), refuse.unavailable()],
            ["minimum", ask({ amount: 9n }), refuse.belowMinimum(10n)],
            ["maximum", ask({ amount: 1_001n }), refuse.aboveMaximum(1_000n)],
        ])("refuses on %s", (_what, refused, answer) => {
            expect(validateAsk(refused, policy)).toEqual(err(answer));
        });

        test("an empty policy serves everything", () => {
            expect(validateAsk(ask({ amount: 1n }), {}).ok).toBe(true);
        });
    });

    describe("quoteId", () => {
        const terms: QuoteTerms = {
            direction: "In",
            rail: "Crypto",
            asset: "USDT",
            network: "polkadot",
            amount: 1_000_000n,
            expiresAt: 1_700_000_000_000,
            extra: "order-7",
        };

        test("round-trips the terms", () => {
            expect(quoteId.decode(quoteId.encode(terms))).toEqual(ok(terms));
        });

        test("tells another provider's id from a broken one", () => {
            expect(quoteId.decode("their-quote")).toEqual(err("foreign"));
            expect(quoteId.decode("pq1.zz")).toEqual(err("malformed"));
        });
    });
}
