/**
 * Higher-level wrapper for the host's entropy derivation (RFC-0007).
 *
 * `hostApi.deriveEntropy` is reachable via {@link getTruApi}, but consumers
 * have to wrap the value in the versioned envelope (`enumValue("v1", ...)`)
 * and unwrap the neverthrow `ResultAsync` themselves. `deriveEntropy`
 * collapses that to a throw-on-error Promise that matches the shape of
 * {@link requestPermission} and {@link requestResourceAllocation}.
 *
 * @module
 */

import { createLogger } from "@parity/product-sdk-logger";

import { enumValue, formatHostError, getTruApi } from "./truapi.js";

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

    return await truApi.deriveEntropy(enumValue("v1", key)).match(
        (envelope: { tag: "v1"; value: Uint8Array }) => envelope.value,
        (err: unknown) => {
            throw new Error(`deriveEntropy failed: ${formatHostError(err)}`, { cause: err });
        },
    );
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("deriveEntropy throws when TruAPI is unavailable", async () => {
        const api = await getTruApi();
        if (api === null) {
            await expect(deriveEntropy(new Uint8Array([1, 2, 3]))).rejects.toThrow(
                /TruAPI unavailable/,
            );
        } else {
            expect(typeof deriveEntropy).toBe("function");
        }
    });
}
