import { createLogger } from "@parity/product-sdk-logger";

import type { QueryStrategy } from "./resolve-query.js";
import { resolveQueryStrategy } from "./resolve-query.js";
import type { QueryOptions } from "./types.js";

const log = createLogger("bulletin");

/**
 * Fetch raw bytes for a CID via the host's preimage lookup.
 *
 * Container-only by design: the bulletin SDK does not retrieve content
 * through public IPFS gateways. Inside a Polkadot Browser / Desktop
 * container, the host's `preimageManager` provides a cached, polling-
 * managed lookup that returns bytes when the underlying IPFS network
 * makes them available. Outside a container, this throws
 * {@link BulletinHostUnavailableError}.
 *
 * The bulletin chain stores transaction *metadata* on-chain
 * (`chunk_root`, `content_hash`, `size`, `cid_codec`, `hashing`) — the
 * content bytes themselves live in IPFS and are surfaced through the
 * host's preimage subscription, never via direct gateway fetch.
 *
 * To prove that a CID was stored on-chain (without fetching the bytes),
 * use `verifyOnChain` from `verify.ts`.
 *
 * @param cid     - CIDv1 string to fetch.
 * @param options - Query options (`lookupTimeoutMs` for host).
 * @throws {BulletinHostUnavailableError} If running outside a container.
 */
export async function queryBytes(cid: string, options?: QueryOptions): Promise<Uint8Array> {
    const strategy = await resolveQueryStrategy();
    return executeQuery(strategy, cid, options);
}

/**
 * Fetch and parse JSON for a CID via the host's preimage lookup.
 *
 * Convenience wrapper over {@link queryBytes}.
 */
export async function queryJson<T>(cid: string, options?: QueryOptions): Promise<T> {
    const bytes = await queryBytes(cid, options);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Execute a query using a pre-resolved strategy.
 *
 * Exposed so `BulletinClient` can resolve the strategy once at
 * construction time and reuse it across calls without re-detecting
 * the host environment on every fetch.
 */
export async function executeQuery(
    strategy: QueryStrategy,
    cid: string,
    options?: QueryOptions,
): Promise<Uint8Array> {
    log.info("query: host preimage lookup", { cid });
    return strategy.lookup(cid, options?.lookupTimeoutMs);
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("executeQuery", () => {
        const testData = new Uint8Array([1, 2, 3]);

        test("delegates to the strategy's lookup function", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            const result = await executeQuery(strategy, "bafytest");
            expect(result).toBe(testData);
            expect(lookup).toHaveBeenCalledWith("bafytest", undefined);
        });

        test("forwards lookupTimeoutMs to the strategy", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            await executeQuery(strategy, "bafytest", { lookupTimeoutMs: 5000 });
            expect(lookup).toHaveBeenCalledWith("bafytest", 5000);
        });
    });
}
