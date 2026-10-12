// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";

/**
 * Build a transaction creator whose underlying signer is resolved on every call.
 *
 * `AsyncBulletinClient` takes a fixed signer at construction, but apps often
 * build the Cloud Storage client before any account is selected. This wrapper
 * defers resolution: each transaction and each `signBytes` call invokes
 * `getSigner()` and forwards to the result. If the getter returns `null`, the
 * call rejects with a clear message.
 *
 * The `publicKey` field is also resolved lazily, so reading it before a signer
 * is available throws rather than returning a stale key from an account that
 * was selected earlier.
 */
export function createLazySigner(
    getSigner: () => CommonSignerTxCreator | null,
    onMissing = "No signer available. Connect a wallet and select an account first.",
): CommonSignerTxCreator {
    const resolve = (): CommonSignerTxCreator => {
        const inner = getSigner();
        if (!inner) throw new Error(onMissing);
        return inner;
    };

    // `async` turns a missing signer into a rejected promise, which is the
    // failure channel PAPI and bulletin-sdk read, instead of a synchronous throw.
    const create = async (...args: Parameters<CommonSignerTxCreator>) => resolve()(...args);
    return Object.defineProperties(create, {
        publicKey: { get: () => resolve().publicKey, enumerable: true },
        signBytes: {
            value: async (data: Uint8Array) => resolve().signBytes(data),
            enumerable: true,
        },
    }) as CommonSignerTxCreator;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    function makeMockSigner(label: string): CommonSignerTxCreator {
        return Object.assign(vi.fn().mockResolvedValue("0x01"), {
            publicKey: new TextEncoder().encode(label),
            signBytes: vi.fn().mockResolvedValue(new Uint8Array([2])),
        }) as unknown as CommonSignerTxCreator;
    }

    type CreatorArgs = Parameters<CommonSignerTxCreator>;
    const args = [{ callData: "0xaabb" }, {}, {}, false] as unknown as CreatorArgs;

    describe("createLazySigner", () => {
        test("publicKey throws when getter returns null", () => {
            const lazy = createLazySigner(() => null);
            expect(() => lazy.publicKey).toThrow("No signer available");
        });

        test("publicKey resolves through getter when signer is available", () => {
            const inner = makeMockSigner("alice");
            const lazy = createLazySigner(() => inner);
            expect(lazy.publicKey).toBe(inner.publicKey);
        });

        test("creating a transaction rejects when getter returns null", async () => {
            const lazy = createLazySigner(() => null);
            await expect(lazy(...args)).rejects.toThrow("No signer available");
        });

        test("creating a transaction forwards to the current signer", async () => {
            const inner = makeMockSigner("alice");
            const lazy = createLazySigner(() => inner);
            const result = await lazy(...args);
            expect(inner).toHaveBeenCalledWith(...args);
            expect(result).toBe("0x01");
        });

        test("signBytes forwards to current signer", async () => {
            const inner = makeMockSigner("bob");
            const lazy = createLazySigner(() => inner);
            const result = await lazy.signBytes(new Uint8Array([9]));
            expect(inner.signBytes).toHaveBeenCalledWith(new Uint8Array([9]));
            expect(result).toEqual(new Uint8Array([2]));
        });

        test("picks up account changes between calls", () => {
            let active: CommonSignerTxCreator | null = makeMockSigner("first");
            const lazy = createLazySigner(() => active);
            expect(lazy.publicKey).toEqual(new TextEncoder().encode("first"));
            active = makeMockSigner("second");
            expect(lazy.publicKey).toEqual(new TextEncoder().encode("second"));
        });

        test("custom error message", () => {
            const lazy = createLazySigner(() => null, "select an account first");
            expect(() => lazy.publicKey).toThrow("select an account first");
        });
    });
}
