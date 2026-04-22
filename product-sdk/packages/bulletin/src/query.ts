import { createLogger } from "@parity/product-sdk-logger";

import { resolveQueryStrategy, type QueryStrategy } from "./resolve-query.js";
import type { QueryOptions } from "./types.js";

const log = createLogger("bulletin");

/**
 * Fetch raw bytes for a CID using the host preimage lookup.
 *
 * Uses local cache + managed IPFS polling via the host container.
 *
 * @param cid     - CIDv1 string to fetch.
 * @param options - Query options (lookupTimeoutMs for host).
 * @returns Raw bytes of the content.
 * @throws {Error} If the host preimage API is unavailable.
 */
export async function queryBytes(cid: string, options?: QueryOptions): Promise<Uint8Array> {
    const strategy = await resolveQueryStrategy();
    return executeQuery(strategy, cid, options);
}

/**
 * Fetch and parse JSON for a CID, auto-resolving the query path.
 *
 * Delegates to {@link queryBytes} and parses the result as JSON.
 *
 * @param cid     - CIDv1 string to fetch.
 * @param options - Query options.
 * @returns Parsed JSON value.
 * @throws {Error} If the host preimage API is unavailable.
 */
export async function queryJson<T>(cid: string, options?: QueryOptions): Promise<T> {
    const bytes = await queryBytes(cid, options);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Execute a query using a pre-resolved strategy.
 *
 * Exposed so that {@link BulletinClient} can resolve the strategy once and
 * reuse it across multiple calls without re-detecting the environment.
 *
 * @param strategy - Pre-resolved query strategy.
 * @param cid      - CIDv1 string to fetch.
 * @param options  - Query options.
 * @returns Raw bytes of the content.
 */
export async function executeQuery(
    strategy: QueryStrategy,
    cid: string,
    options?: QueryOptions,
): Promise<Uint8Array> {
    log.info("querying via host preimage lookup", { cid });
    return strategy.lookup(cid, options?.lookupTimeoutMs);
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    // Note: queryBytes and queryJson tests require e2e testing as they
    // depend on the host container environment for strategy resolution.

    describe("executeQuery", () => {
        const testData = new Uint8Array([1, 2, 3]);

        test("executes host-lookup strategy", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            const result = await executeQuery(strategy, "bafytest");
            expect(result).toBe(testData);
            expect(lookup).toHaveBeenCalledWith("bafytest", undefined);
        });

        test("passes lookupTimeoutMs to host-lookup", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            await executeQuery(strategy, "bafytest", { lookupTimeoutMs: 5000 });
            expect(lookup).toHaveBeenCalledWith("bafytest", 5000);
        });
    });
}
