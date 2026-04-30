import { createLogger } from "@parity/product-sdk-logger";

import { BulletinGatewayUnavailableError } from "./errors.js";
import { fetchBytes as fetchFromGateway } from "./gateway.js";
import type { BulletinApi, QueryOptions } from "./types.js";

const log = createLogger("bulletin");

/**
 * Fetch content for a CID, trying chain storage first and falling back to
 * the IPFS gateway.
 *
 * Read order:
 *
 * 1. **Chain storage** — direct query of `TransactionStorage` (placeholder
 *    until the runtime exposes the CID-keyed query item; today this returns
 *    `null` and we always fall through).
 * 2. **IPFS gateway** — works for content stored via the chain, including
 *    chunked / DAG-PB content (the gateway reassembles UnixFS automatically).
 *
 * If neither path is configured (no chain query + no gateway), throws
 * {@link BulletinGatewayUnavailableError}.
 */
export async function fetchContent(
    api: BulletinApi,
    gateway: string | null,
    cid: string,
    options?: QueryOptions,
): Promise<Uint8Array> {
    const onChain = await readFromChainStorage(api, cid);
    if (onChain) {
        log.info("query: served from chain storage", { cid });
        return onChain;
    }

    if (!gateway) {
        throw new BulletinGatewayUnavailableError("(no gateway configured)");
    }

    log.info("query: chain miss, falling back to gateway", { cid, gateway });
    return fetchFromGateway(cid, gateway, options);
}

/**
 * Read content directly from chain storage.
 *
 * Currently a placeholder. The bulletin runtime exposes `TransactionStorage`
 * pallet items, but the CID-keyed read mapping is still being defined — see
 * the issue tracker for the runtime support timeline. Until then this always
 * returns `null` and `fetchContent` falls back to the gateway.
 *
 * When the runtime exposes the necessary item, replace the body with a typed
 * call along the lines of:
 *
 * ```ts
 * const bytes = await api.query.TransactionStorage.Transactions.getValue(...);
 * ```
 */
export async function readFromChainStorage(
    _api: BulletinApi,
    _cid: string,
): Promise<Uint8Array | null> {
    return null;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("readFromChainStorage", () => {
        test("returns null until runtime support lands", async () => {
            const result = await readFromChainStorage({} as BulletinApi, "bafyabc");
            expect(result).toBeNull();
        });
    });

    describe("fetchContent", () => {
        const cid = "bafyabc";
        const data = new Uint8Array([1, 2, 3]);

        test("falls through to gateway when chain returns null", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn().mockResolvedValue({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(data.buffer),
                }),
            );
            const result = await fetchContent({} as BulletinApi, "https://gw/ipfs/", cid);
            expect(result).toEqual(data);
            vi.unstubAllGlobals();
        });

        test("throws when no gateway and chain returns null", async () => {
            await expect(fetchContent({} as BulletinApi, null, cid)).rejects.toThrow(
                BulletinGatewayUnavailableError,
            );
        });
    });
}
