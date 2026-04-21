import { createLogger } from "@parity/product-sdk-logger";
import { submitAndWatch, withRetry } from "@parity/product-sdk-tx";
import type { PolkadotSigner } from "polkadot-api";
import { Binary } from "polkadot-api";

import { computeCid } from "./cid.js";
import { gatewayUrl } from "./gateway.js";
import { resolveUploadStrategy } from "./resolve-signer.js";
import type {
    BatchUploadItem,
    BatchUploadOptions,
    BatchUploadResult,
    BulletinApi,
    UploadOptions,
    UploadResult,
} from "./types.js";

const log = createLogger("bulletin");

/**
 * Upload data to the Bulletin Chain.
 *
 * When a signer is provided, submits a `TransactionStorage.store` transaction
 * directly. When omitted, uses the host preimage API — the host signs and
 * submits automatically.
 *
 * Computes the CIDv1 (blake2b-256, raw codec) locally.
 *
 * @param api    - Typed Bulletin Chain API.
 * @param data   - Raw bytes to store.
 * @param signer - Optional signer. When omitted, uses host preimage API.
 * @param options - Upload options (gateway, timeout, waitFor, status callback).
 * @returns Upload result with CID and either blockHash or preimageKey.
 */
export async function upload(
    api: BulletinApi,
    data: Uint8Array,
    signer?: PolkadotSigner,
    options?: UploadOptions,
): Promise<UploadResult> {
    const strategy = await resolveUploadStrategy(signer);
    const cid = computeCid(data);

    if (strategy.kind === "preimage") {
        log.info("uploading via host preimage API", { cid, size: data.byteLength });
        const preimageKey = await strategy.submit(data);
        log.info("preimage submitted successfully", { cid, preimageKey });
        return {
            kind: "preimage",
            cid,
            preimageKey,
            gatewayUrl: options?.gateway ? gatewayUrl(cid, options.gateway) : undefined,
        };
    }

    log.info("uploading via TransactionStorage.store", { cid, size: data.byteLength });
    const result = await withRetry(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx = (api as any).tx.TransactionStorage.store({ data: Binary.fromBytes(data) });
        return submitAndWatch(tx, strategy.signer, {
            waitFor: options?.waitFor,
            timeoutMs: options?.timeoutMs,
            onStatus: options?.onStatus,
        });
    });

    log.info("transaction included in block", { cid, blockHash: result.block.hash });
    return {
        kind: "transaction",
        cid,
        blockHash: result.block.hash,
        gatewayUrl: options?.gateway ? gatewayUrl(cid, options.gateway) : undefined,
    };
}

/**
 * Upload multiple items sequentially to the Bulletin Chain.
 *
 * Bulletin Chain requires sequential transaction submission (nonce ordering).
 * Individual failures are captured in results — the batch does not abort.
 *
 * Signer resolution follows the same rules as {@link upload}: when omitted,
 * the strategy is auto-resolved once and reused for all items.
 *
 * @param api    - Typed Bulletin Chain API.
 * @param items  - Array of items to upload, each with data and a label.
 * @param signer - Optional signer. When omitted, auto-resolved.
 * @param options - Batch upload options (gateway, timeout, progress callback).
 * @returns Array of results, one per item, preserving input order.
 */
export async function batchUpload(
    api: BulletinApi,
    items: BatchUploadItem[],
    signer?: PolkadotSigner,
    options?: BatchUploadOptions,
): Promise<BatchUploadResult[]> {
    if (items.length === 0) return [];

    const strategy = await resolveUploadStrategy(signer);
    const results: BatchUploadResult[] = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const cid = computeCid(item.data);

        try {
            if (strategy.kind === "preimage") {
                log.info("batch: uploading item via preimage", {
                    label: item.label,
                    index: i,
                    total: items.length,
                });
                const preimageKey = await strategy.submit(item.data);

                const entry: BatchUploadResult = {
                    kind: "preimage",
                    label: item.label,
                    cid,
                    success: true,
                    preimageKey,
                    gatewayUrl: options?.gateway ? gatewayUrl(cid, options.gateway) : undefined,
                };
                results.push(entry);
                options?.onProgress?.(i + 1, items.length, entry);
            } else {
                log.info("batch: uploading item via transaction", {
                    label: item.label,
                    index: i,
                    total: items.length,
                });
                const result = await withRetry(() => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const tx = (api as any).tx.TransactionStorage.store({
                        data: Binary.fromBytes(item.data),
                    });
                    return submitAndWatch(tx, strategy.signer, {
                        waitFor: options?.waitFor,
                        timeoutMs: options?.timeoutMs,
                    });
                });

                const entry: BatchUploadResult = {
                    kind: "transaction",
                    label: item.label,
                    cid,
                    success: true,
                    blockHash: result.block.hash,
                    gatewayUrl: options?.gateway ? gatewayUrl(cid, options.gateway) : undefined,
                };
                results.push(entry);
                options?.onProgress?.(i + 1, items.length, entry);
            }
        } catch (err) {
            log.error("batch: item upload failed", {
                label: item.label,
                index: i,
                error: err instanceof Error ? err.message : String(err),
            });
            const entry: BatchUploadResult = {
                kind: strategy.kind === "preimage" ? "preimage" : "transaction",
                label: item.label,
                cid,
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
            results.push(entry);
            options?.onProgress?.(i + 1, items.length, entry);
        }
    }

    return results;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    function createMockApi() {
        return {
            tx: {
                TransactionStorage: {
                    store: vi.fn().mockReturnValue({
                        signSubmitAndWatch: () => ({
                            subscribe: (handlers: { next: (e: unknown) => void }) => {
                                queueMicrotask(() => {
                                    handlers.next({ type: "signed", txHash: "0xtxhash" });
                                    handlers.next({
                                        type: "txBestBlocksState",
                                        txHash: "0xtxhash",
                                        found: true,
                                        ok: true,
                                        block: { hash: "0xblockhash", number: 1, index: 0 },
                                        events: [],
                                    });
                                });
                                return { unsubscribe: vi.fn() };
                            },
                        }),
                    }),
                },
            },
        };
    }

    const mockSigner = {} as PolkadotSigner;

    describe("upload", () => {
        test("calls TransactionStorage.store and returns CID + blockHash with explicit signer", async () => {
            const api = createMockApi();
            const data = new TextEncoder().encode("test data");
            const result = await upload(api as unknown as BulletinApi, data, mockSigner);

            expect(api.tx.TransactionStorage.store).toHaveBeenCalledOnce();
            expect(result.kind).toBe("transaction");
            expect(result.cid).toBeTruthy();
            if (result.kind === "transaction") {
                expect(result.blockHash).toBe("0xblockhash");
            }
        });

        test("includes gatewayUrl when gateway option provided", async () => {
            const api = createMockApi();
            const data = new TextEncoder().encode("test");
            const result = await upload(api as unknown as BulletinApi, data, mockSigner, {
                gateway: "https://gw/ipfs/",
            });

            expect(result.gatewayUrl).toBe(`https://gw/ipfs/${result.cid}`);
        });

        test("omits gatewayUrl when no gateway option", async () => {
            const api = createMockApi();
            const data = new TextEncoder().encode("test");
            const result = await upload(api as unknown as BulletinApi, data, mockSigner);

            expect(result.gatewayUrl).toBeUndefined();
        });
    });

    describe("batchUpload", () => {
        test("returns empty array for empty items", async () => {
            const api = createMockApi();
            const results = await batchUpload(api as unknown as BulletinApi, [], mockSigner);
            expect(results).toEqual([]);
        });

        test("processes items sequentially with explicit signer", async () => {
            const api = createMockApi();
            const items: BatchUploadItem[] = [
                { data: new TextEncoder().encode("a"), label: "file-a" },
                { data: new TextEncoder().encode("b"), label: "file-b" },
            ];
            const results = await batchUpload(api as unknown as BulletinApi, items, mockSigner);

            expect(results).toHaveLength(2);
            expect(results[0]!.kind).toBe("transaction");
            expect(results[0]!.label).toBe("file-a");
            expect(results[0]!.success).toBe(true);
            expect(results[1]!.kind).toBe("transaction");
            expect(results[1]!.label).toBe("file-b");
            expect(results[1]!.success).toBe(true);
        });

        test("captures individual failures without aborting batch", async () => {
            const api = createMockApi();
            // Make the second call fail with a dispatch error (non-retryable)
            let callCount = 0;
            api.tx.TransactionStorage.store.mockImplementation(() => {
                callCount++;
                if (callCount === 2) {
                    return {
                        signSubmitAndWatch: () => ({
                            subscribe: (handlers: { next: (e: unknown) => void }) => {
                                queueMicrotask(() => {
                                    handlers.next({ type: "signed", txHash: "0x" });
                                    handlers.next({
                                        type: "txBestBlocksState",
                                        txHash: "0x",
                                        found: true,
                                        ok: false,
                                        block: { hash: "0xblock", number: 1, index: 0 },
                                        events: [],
                                        dispatchError: { type: "BadOrigin" },
                                    });
                                });
                                return { unsubscribe: vi.fn() };
                            },
                        }),
                    };
                }
                return {
                    signSubmitAndWatch: () => ({
                        subscribe: (handlers: { next: (e: unknown) => void }) => {
                            queueMicrotask(() => {
                                handlers.next({ type: "signed", txHash: "0x" });
                                handlers.next({
                                    type: "txBestBlocksState",
                                    txHash: "0x",
                                    found: true,
                                    ok: true,
                                    block: { hash: "0xblock", number: 1, index: 0 },
                                    events: [],
                                });
                            });
                            return { unsubscribe: vi.fn() };
                        },
                    }),
                };
            });

            const items: BatchUploadItem[] = [
                { data: new TextEncoder().encode("a"), label: "ok" },
                { data: new TextEncoder().encode("b"), label: "fail" },
                { data: new TextEncoder().encode("c"), label: "ok2" },
            ];
            const results = await batchUpload(api as unknown as BulletinApi, items, mockSigner);

            expect(results).toHaveLength(3);
            expect(results[0]!.kind).toBe("transaction");
            expect(results[0]!.success).toBe(true);
            const f1 = results[1]!;
            expect(f1.kind).toBe("transaction");
            expect(f1.success).toBe(false);
            if (!f1.success) expect(f1.error).toContain("BadOrigin");
            expect(results[2]!.success).toBe(true);
        });

        test("calls onProgress for each item", async () => {
            const api = createMockApi();
            const items: BatchUploadItem[] = [
                { data: new TextEncoder().encode("a"), label: "a" },
                { data: new TextEncoder().encode("b"), label: "b" },
            ];
            const progress: Array<[number, number, string]> = [];
            await batchUpload(api as unknown as BulletinApi, items, mockSigner, {
                onProgress: (done, total, current) => progress.push([done, total, current.label]),
            });

            expect(progress).toEqual([
                [1, 2, "a"],
                [2, 2, "b"],
            ]);
        });
    });
}
