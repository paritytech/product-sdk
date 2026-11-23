// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

/** A truapi call's error as a readable message: the tag, and a reason when the error has one. */
export function describeCallError(error: unknown): string {
    const { tag, value } = error as { tag?: string; value?: unknown };
    if (!tag) return String(error);
    if (value && typeof value === "object" && "tag" in value)
        return `${tag}: ${describeCallError(value)}`;
    const reason = (value as { reason?: string } | undefined)?.reason;
    return reason ? `${tag}: ${reason}` : tag;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("describeCallError", () => {
        test("reads through the domain and version wrappers down to the reason", () => {
            const error = {
                tag: "Domain",
                value: { tag: "V1", value: { tag: "Unknown", value: { reason: "Not connected" } } },
            };
            expect([describeCallError(error), describeCallError({ tag: "Rejected" })]).toEqual([
                "Domain: V1: Unknown: Not connected",
                "Rejected",
            ]);
        });
    });
}
