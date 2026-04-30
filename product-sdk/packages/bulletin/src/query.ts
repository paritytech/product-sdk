import { createLogger } from "@parity/product-sdk-logger";

import { BulletinGatewayUnavailableError } from "./errors.js";
import { fetchBytes as fetchFromGateway } from "./gateway.js";
import type { BulletinApi, QueryOptions } from "./types.js";

const log = createLogger("bulletin");

/**
 * Fetch content for a CID from the configured IPFS gateway.
 *
 * The bulletin chain stores transaction *metadata* on-chain (`chunk_root`,
 * `content_hash`, `size`, `cid_codec`, hashing) but the content bytes
 * themselves live in IPFS. There is no `api.query.TransactionStorage` item
 * that returns raw bytes — the chain only knows about hashes. So byte
 * retrieval always goes through the gateway, which transparently handles
 * chunked / DAG-PB content via UnixFS reassembly.
 *
 * To prove that a CID was stored on-chain (without fetching the bytes),
 * use {@link verifyOnChain} from `verify.ts`.
 *
 * @throws {BulletinGatewayUnavailableError} If `gateway` is `null`.
 */
export async function fetchContent(
    _api: BulletinApi,
    gateway: string | null,
    cid: string,
    options?: QueryOptions,
): Promise<Uint8Array> {
    if (!gateway) {
        throw new BulletinGatewayUnavailableError("(no gateway configured)");
    }

    log.info("query: fetching from gateway", { cid, gateway });
    return fetchFromGateway(cid, gateway, options);
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("fetchContent", () => {
        const cid = "bafyabc";
        const data = new Uint8Array([1, 2, 3]);

        test("fetches via gateway when one is configured", async () => {
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

        test("throws when no gateway is configured", async () => {
            await expect(fetchContent({} as BulletinApi, null, cid)).rejects.toThrow(
                BulletinGatewayUnavailableError,
            );
        });
    });
}
