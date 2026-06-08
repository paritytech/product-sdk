// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's entropy derivation (RFC-0007).
 *
 * `truApi.entropy.derive` takes a hex `context` and returns a hex `entropy`
 * payload wrapped in a neverthrow `ResultAsync`. `deriveEntropy` keeps the
 * ergonomic `Uint8Array → Uint8Array` signature: it hex-encodes the context on
 * the way in, decodes the entropy on the way out, and throws on error — the
 * shape of {@link requestPermission} and {@link requestResourceAllocation}.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { fromHex, getTruApi, toHex, unwrapHostResult } from "./truapi.js";

const log = createLogger("host:entropy");

/**
 * Derive deterministic entropy from a context key (RFC-0007).
 *
 * The host derives entropy from the user's wallet + the provided context
 * key. Calling with the same key on the same wallet yields the same bytes;
 * different keys (or different wallets) yield uncorrelated entropy.
 *
 * @param key - Context key bytes (typically a SCALE-encoded discriminator).
 * @returns The derived entropy bytes.
 * @throws If the host is unavailable or the host-side derivation fails.
 *
 * @example
 * ```ts
 * import { deriveEntropy } from "@parity/product-sdk-host";
 *
 * const seed = await deriveEntropy(new TextEncoder().encode("my-app:seed-v1"));
 * ```
 */
export async function deriveEntropy(key: Uint8Array): Promise<Uint8Array> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("deriveEntropy: TruAPI unavailable");
    }
    log.debug("deriveEntropy", { keyLen: key.length });

    const response = await unwrapHostResult(
        truApi.entropy.derive({ context: toHex(key) }),
        "deriveEntropy failed",
    );
    return fromHex(response.entropy);
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    function okAsync<T>(value: T) {
        return { match: async (onOk: (v: T) => unknown) => onOk(value) };
    }

    async function withMockedTruApi<T>(
        client: unknown,
        fn: (mod: typeof import("./entropy.js")) => Promise<T>,
    ): Promise<T> {
        vi.resetModules();
        vi.doMock("./truapi.js", async (importOriginal) => {
            const original = await importOriginal<typeof import("./truapi.js")>();
            return { ...original, getTruApi: async () => client };
        });
        try {
            const mod = await import("./entropy.js");
            return await fn(mod);
        } finally {
            vi.doUnmock("./truapi.js");
            vi.resetModules();
        }
    }

    // Tests live inside `describe` so the re-import in `withMockedTruApi`
    // (via `vi.resetModules`) doesn't re-register top-level `test()` calls.
    describe("deriveEntropy", () => {
        test("throws when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                await expect(mod.deriveEntropy(new Uint8Array([1, 2, 3]))).rejects.toThrow(
                    /TruAPI unavailable/,
                );
            });
        });

        test("hex-encodes the context and decodes the entropy bytes", async () => {
            const derive = vi.fn(() => okAsync({ entropy: "0xc0ffee" }));
            await withMockedTruApi({ entropy: { derive } }, async (mod) => {
                const out = await mod.deriveEntropy(new Uint8Array([0xab, 0xcd]));
                expect(derive).toHaveBeenCalledWith({ context: "0xabcd" });
                expect(Array.from(out)).toEqual([0xc0, 0xff, 0xee]);
            });
        });
    });
}
