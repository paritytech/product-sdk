// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The account the weekly game is played on.
 *
 * Every product that touches a player's game record has to name the same
 * product account: the game product, `Game.product_name` on chain (`dim2`),
 * under the network's DotNS TLD, at one derivation index. The game product
 * signs players up and plays on it. The personhood product registers personhood
 * and signs players up as it, under the game product's `context` grant. The
 * collectibles product claims the credits the game awards to it. Naming it once
 * here keeps all of them on one account.
 */
import { ProductIndividualityError } from "./errors.js";

/** `Game.product_name`: the product the game pallet scopes its draws to. */
export const GAME_PRODUCT_NAME = "dim2";

/**
 * The derivation index of the game account: 0, the host's default product
 * account (RFC-0022 `//product//dim2/0`). Every product must use the same one,
 * because a lite person's free seat is pinned to a single account for good
 * (`Game.LiteInvites`).
 */
export const GAME_ACCOUNT_INDEX = 0;

/**
 * The game product's DotNS id on a network, such as `"dim2.paseo"`: the id a
 * host derives the game account from, and the product a draw proof's context
 * names. Lower case, because the chain hashes the raw string.
 *
 * @throws ProductIndividualityError when `tld` is empty or has a dot inside.
 */
export function gameProductId(tld: string): string {
    const bare = tld.trim().replace(/^\./, "").toLowerCase();
    if (bare.length === 0 || bare.includes(".")) {
        throw new ProductIndividualityError(`not a DotNS TLD: "${tld}"`);
    }
    return `${GAME_PRODUCT_NAME}.${bare}`;
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    describe("GAME_ACCOUNT_INDEX", () => {
        test("is the host's default product account", () => {
            expect(GAME_ACCOUNT_INDEX).toBe(0);
        });
    });

    describe("gameProductId", () => {
        test("joins the game product to the TLD", () => {
            expect(gameProductId("paseo")).toBe("dim2.paseo");
            expect(gameProductId("testnet")).toBe("dim2.testnet");
        });

        test("takes a TLD written with its dot, or in capitals", () => {
            expect(gameProductId(".paseo")).toBe("dim2.paseo");
            expect(gameProductId("PASEO")).toBe("dim2.paseo");
        });

        test("refuses an empty TLD or a full name", () => {
            expect(() => gameProductId("")).toThrow(ProductIndividualityError);
            expect(() => gameProductId("dim2.paseo")).toThrow(ProductIndividualityError);
        });
    });
}
