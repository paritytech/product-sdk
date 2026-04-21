import { createLogger } from "@parity/product-sdk-logger";

import { fetchBytes as gatewayFetchBytes } from "./gateway.js";
import { resolveQueryStrategy, type QueryStrategy } from "./resolve-query.js";
import type { QueryOptions } from "./types.js";

const log = createLogger("bulletin");

/**
 * Fetch raw bytes for a CID using the host preimage lookup.
 *
 * Uses local cache + managed IPFS polling via the host container.
 *
 * @param cid     - CIDv1 string to fetch.
 * @param gateway - IPFS gateway base URL (fallback).
 * @param options - Query options (timeoutMs, lookupTimeoutMs for host).
 * @returns Raw bytes of the content.
 */
export async function queryBytes(
    cid: string,
    gateway: string,
    options?: QueryOptions,
): Promise<Uint8Array> {
    const strategy = await resolveQueryStrategy();
    return executeQuery(strategy, cid, gateway, options);
}

/**
 * Fetch and parse JSON for a CID, auto-resolving the query path.
 *
 * Delegates to {@link queryBytes} and parses the result as JSON.
 *
 * @param cid     - CIDv1 string to fetch.
 * @param gateway - IPFS gateway base URL.
 * @param options - Query options.
 * @returns Parsed JSON value.
 */
export async function queryJson<T>(
    cid: string,
    gateway: string,
    options?: QueryOptions,
): Promise<T> {
    const bytes = await queryBytes(cid, gateway, options);
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
 * @param gateway  - IPFS gateway base URL (used only for `"gateway"` strategy).
 * @param options  - Query options.
 * @returns Raw bytes of the content.
 */
export async function executeQuery(
    strategy: QueryStrategy,
    cid: string,
    gateway: string,
    options?: QueryOptions,
): Promise<Uint8Array> {
    if (strategy.kind === "host-lookup") {
        log.info("querying via host preimage lookup", { cid });
        return strategy.lookup(cid, options?.lookupTimeoutMs);
    }

    log.info("querying via IPFS gateway", { cid });
    return gatewayFetchBytes(cid, gateway, options);
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("queryBytes", () => {
        test("resolves via gateway outside container and returns bytes", async () => {
            const payload = new Uint8Array([4, 5, 6]);
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(payload.buffer),
                }),
            );
            try {
                const result = await queryBytes("bafytest", "https://gw/ipfs/");
                expect(result).toEqual(payload);
            } finally {
                vi.unstubAllGlobals();
            }
        });
    });

    describe("queryJson", () => {
        test("resolves via gateway outside container and parses JSON", async () => {
            const obj = { hello: "world" };
            const bytes = new TextEncoder().encode(JSON.stringify(obj));
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(bytes.buffer),
                }),
            );
            try {
                const result = await queryJson<typeof obj>("bafytest", "https://gw/ipfs/");
                expect(result).toEqual(obj);
            } finally {
                vi.unstubAllGlobals();
            }
        });
    });

    describe("executeQuery", () => {
        const testData = new Uint8Array([1, 2, 3]);

        test("dispatches to host-lookup strategy", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            const result = await executeQuery(strategy, "bafytest", "https://gw/ipfs/");
            expect(result).toBe(testData);
            expect(lookup).toHaveBeenCalledWith("bafytest", undefined);
        });

        test("passes lookupTimeoutMs to host-lookup", async () => {
            const lookup = vi.fn().mockResolvedValue(testData);
            const strategy: QueryStrategy = { kind: "host-lookup", lookup };
            await executeQuery(strategy, "bafytest", "https://gw/ipfs/", {
                lookupTimeoutMs: 5000,
            });
            expect(lookup).toHaveBeenCalledWith("bafytest", 5000);
        });

        test("dispatches to gateway strategy via fetch", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(testData.buffer),
                }),
            );
            try {
                const strategy: QueryStrategy = { kind: "gateway" };
                const result = await executeQuery(strategy, "bafytest", "https://gw/ipfs/");
                expect(result).toEqual(testData);
            } finally {
                vi.unstubAllGlobals();
            }
        });
    });
}
