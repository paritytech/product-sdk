// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Higher-level wrapper for the host's entropy derivation (RFC-0007).
 *
 * `truApi.entropy.derive` takes a hex `context` and returns a hex `entropy`
 * payload wrapped in a neverthrow `ResultAsync`. `deriveEntropy` keeps the
 * ergonomic `Uint8Array → Result<Uint8Array, HostError>` signature: it
 * hex-encodes the context on the way in and decodes the entropy on the way out —
 * the shape of {@link requestPermission} and {@link requestResourceAllocation}.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { type HostError, HostUnavailableError } from "./errors.js";
import { type Result, err } from "./result.js";
import { fromHex, getTruApi, mapHostResult, toHex } from "./truapi.js";

const log = createLogger("host:entropy");

/**
 * Derive deterministic entropy from a context key (RFC-0007).
 *
 * The host derives entropy from the user's wallet + the provided context
 * key. Calling with the same key on the same wallet yields the same bytes;
 * different keys (or different wallets) yield uncorrelated entropy.
 *
 * @param key - Context key bytes (typically a SCALE-encoded discriminator).
 * @returns `ok` with the derived entropy bytes, or
 *   `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * import { deriveEntropy } from "@parity/product-sdk-host";
 *
 * const r = await deriveEntropy(new TextEncoder().encode("my-app:seed-v1"));
 * if (r.ok) { const seed = r.value; }
 * ```
 */
export async function deriveEntropy(key: Uint8Array): Promise<Result<Uint8Array, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("deriveEntropy: TruAPI unavailable"));
    }
    log.debug("deriveEntropy", { keyLen: key.length });

    return mapHostResult(
        truApi.entropy.derive({ context: toHex(key) }),
        (response) => fromHex(response.entropy),
        "deriveEntropy failed",
    );
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
        test("returns err(HostUnavailableError) when TruAPI is unavailable", async () => {
            await withMockedTruApi(null, async (mod) => {
                const result = await mod.deriveEntropy(new Uint8Array([1, 2, 3]));
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.name).toBe("HostUnavailableError");
                }
            });
        });

        test("hex-encodes the context and decodes the entropy bytes", async () => {
            const derive = vi.fn(() => okAsync({ entropy: "0xc0ffee" }));
            await withMockedTruApi({ entropy: { derive } }, async (mod) => {
                const result = await mod.deriveEntropy(new Uint8Array([0xab, 0xcd]));
                expect(derive).toHaveBeenCalledWith({ context: "0xabcd" });
                expect(result.ok).toBe(true);
                if (result.ok) {
                    expect(Array.from(result.value)).toEqual([0xc0, 0xff, 0xee]);
                }
            });
        });
    });
}
