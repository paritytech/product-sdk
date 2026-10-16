// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The core's ordering of a session's reports, as the funding RFC defines it,
 * so a session can tell a report the core already has from one it refuses.
 *
 * The fake core in `@parity/product-sdk-host/testing` and its table test
 * follow the same rules.
 *
 * @module
 */
import type { FundingUpdate } from "@parity/truapi";

/**
 * Where `update` ranks among a session's steps: a later step ranks higher,
 * and a top-up or payment request ranks where funds start moving. `Deposit`,
 * `Details` and the payout updates have no place in the order.
 */
export function updateRank(update: FundingUpdate): number | undefined {
    switch (update.tag) {
        case "AwaitingPayment":
            return 0;
        case "PaymentReceived":
            return update.value.finalized ? 2 : 1;
        case "Converting":
            return 3;
        case "Crediting":
        case "Collecting":
            return 4;
        case "Delivered":
            return 5;
        case "Failed":
            return 6;
        default:
            return undefined;
    }
}

/** Updates an outbound session reports once it is released, about paying the user out. */
export function isAfterRelease(update: FundingUpdate, direction: "In" | "Out"): boolean {
    return (
        update.tag === "Payout" ||
        update.tag === "Refunding" ||
        update.tag === "PayoutRetrying" ||
        (update.tag === "Converting" && direction === "Out")
    );
}

/**
 * Whether the core already holds `update`, given the last ranked step it
 * has: a ranked step at or below it, except another top-up, which may follow
 * one. The core would refuse such a report as `OutOfOrder`. Updates about a
 * released withdrawal's payout are outside the order, so never held by rank.
 */
export function coreHas(
    lastStep: FundingUpdate | undefined,
    update: FundingUpdate,
    direction: "In" | "Out",
): boolean {
    if (isAfterRelease(update, direction)) return false;
    const rank = updateRank(update);
    const last = lastStep === undefined ? undefined : updateRank(lastStep);
    if (rank === undefined || last === undefined || update.tag === "Crediting") return false;
    return rank <= last;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("a step at or below the last one is already held", () => {
        const awaiting: FundingUpdate = { tag: "AwaitingPayment" };
        const received: FundingUpdate = { tag: "PaymentReceived", value: { finalized: true } };
        expect(coreHas(received, awaiting, "In")).toBe(true);
        expect(coreHas(awaiting, received, "In")).toBe(false);
        expect(coreHas(received, received, "In")).toBe(true);
        expect(coreHas(undefined, awaiting, "In")).toBe(false);
    });

    test("another top-up may follow a top-up", () => {
        const crediting: FundingUpdate = {
            tag: "Crediting",
            value: { topUpId: "0x01", amount: 1n },
        };
        expect(coreHas(crediting, crediting, "In")).toBe(false);
    });

    test("unranked updates are never held by rank", () => {
        expect(coreHas({ tag: "Delivered" }, { tag: "Details", value: {} }, "In")).toBe(false);
    });

    test("a withdrawal's Converting after release is outside the order", () => {
        const collecting: FundingUpdate = {
            tag: "Collecting",
            value: { paymentId: "0x01", amount: 1n },
        };
        expect(coreHas(collecting, { tag: "Converting" }, "Out")).toBe(false);
        expect(coreHas(collecting, { tag: "Converting" }, "In")).toBe(true);
    });
}
