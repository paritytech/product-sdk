import { getPreimageManager, type PreimageManager } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";

import { cidToPreimageKey, computeCid } from "./cid.js";
import {
    BulletinHostUnavailableError,
    BulletinLookupInterruptedError,
    BulletinLookupTimeoutError,
} from "./errors.js";

const log = createLogger("bulletin");

const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;

/**
 * Query strategy for the Bulletin Chain.
 *
 * The host manages the lookup via its preimage subscription API,
 * which includes local caching and managed IPFS polling.
 */
export interface QueryStrategy {
    kind: "host-lookup";
    lookup: (cid: string, timeoutMs?: number) => Promise<Uint8Array>;
}

/**
 * Determine the query strategy for the Bulletin Chain.
 *
 * Uses the host preimage lookup API which caches results and manages
 * IPFS polling automatically.
 *
 * @returns The resolved query strategy.
 * @throws {BulletinHostUnavailableError} If the host preimage manager is unavailable.
 */
export async function resolveQueryStrategy(): Promise<QueryStrategy> {
    const preimageManager = await getPreimageManager();
    if (preimageManager) {
        log.info("using host preimage lookup for bulletin queries");
        return {
            kind: "host-lookup",
            lookup: (cid, timeoutMs) => lookupViaHost(preimageManager, cid, timeoutMs),
        };
    }

    throw new BulletinHostUnavailableError("query");
}

/**
 * Wrap `preimageManager.lookup` (subscription-based) into a one-shot Promise.
 *
 * Converts the CID to a hex preimage key, subscribes, and resolves on the
 * first non-null callback. Rejects on timeout or if the host interrupts the
 * subscription (e.g. after repeated failures). Always unsubscribes on settlement.
 *
 * @param manager   - The product-sdk preimage manager.
 * @param cid       - CIDv1 string to look up.
 * @param timeoutMs - Maximum wait time. Default: 30_000ms.
 * @returns The raw bytes of the preimage.
 */
export function lookupViaHost(
    manager: PreimageManager,
    cid: string,
    timeoutMs: number = DEFAULT_LOOKUP_TIMEOUT_MS,
): Promise<Uint8Array> {
    const key = cidToPreimageKey(cid);

    return new Promise<Uint8Array>((resolve, reject) => {
        const cleanup = () => {
            cancelInterrupt();
            sub.unsubscribe();
        };

        const settle = (fn: () => void) => {
            if (timer === null) return;
            clearTimeout(timer);
            timer = null;
            cleanup();
            fn();
        };

        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            settle(() => {
                reject(new BulletinLookupTimeoutError(cid, timeoutMs));
            });
        }, timeoutMs);

        const sub = manager.lookup(key, (preimage) => {
            if (preimage !== null) {
                settle(() => resolve(preimage));
            }
            // null means "not found yet" — host will keep polling
        });

        const cancelInterrupt = sub.onInterrupt(() => {
            settle(() => {
                reject(new BulletinLookupInterruptedError(cid));
            });
        });
    });
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    // Note: resolveQueryStrategy tests require e2e testing as they
    // depend on the host container environment.

    describe("lookupViaHost", () => {
        function createMockManager(
            behavior: "resolve" | "null-then-resolve" | "hang" | "interrupt",
        ) {
            const unsubscribe = vi.fn();
            const cancelInterrupt = vi.fn();
            let interruptCb: VoidFunction | undefined;

            const lookup = vi.fn((_key: string, callback: (p: Uint8Array | null) => void) => {
                const data = new Uint8Array([10, 20, 30]);
                queueMicrotask(() => {
                    if (behavior === "resolve") {
                        callback(data);
                    } else if (behavior === "null-then-resolve") {
                        callback(null);
                        queueMicrotask(() => callback(data));
                    } else if (behavior === "interrupt") {
                        interruptCb?.();
                    }
                    // "hang" does nothing
                });
                return {
                    unsubscribe,
                    onInterrupt: (cb: VoidFunction) => {
                        interruptCb = cb;
                        return cancelInterrupt;
                    },
                };
            });

            return { lookup, unsubscribe, cancelInterrupt, submit: vi.fn() };
        }

        const testCid = computeCid(new TextEncoder().encode("test"));

        test("resolves on first non-null callback", async () => {
            const manager = createMockManager("resolve");
            const result = await lookupViaHost(manager, testCid);
            expect(result).toEqual(new Uint8Array([10, 20, 30]));
        });

        test("ignores null callbacks and resolves on subsequent data", async () => {
            const manager = createMockManager("null-then-resolve");
            const result = await lookupViaHost(manager, testCid);
            expect(result).toEqual(new Uint8Array([10, 20, 30]));
        });

        test("rejects with BulletinLookupTimeoutError on timeout", async () => {
            const { BulletinLookupTimeoutError } = await import("./errors.js");
            const manager = createMockManager("hang");
            const err = await lookupViaHost(manager, testCid, 50).catch((e) => e);
            expect(err).toBeInstanceOf(BulletinLookupTimeoutError);
            expect(err.cid).toBe(testCid);
            expect(err.timeoutMs).toBe(50);
        });

        test("rejects with BulletinLookupInterruptedError on interrupt", async () => {
            const { BulletinLookupInterruptedError } = await import("./errors.js");
            const manager = createMockManager("interrupt");
            const err = await lookupViaHost(manager, testCid).catch((e) => e);
            expect(err).toBeInstanceOf(BulletinLookupInterruptedError);
            expect(err.cid).toBe(testCid);
        });

        test("calls unsubscribe and cancelInterrupt on resolution", async () => {
            const manager = createMockManager("resolve");
            await lookupViaHost(manager, testCid);
            expect(manager.unsubscribe).toHaveBeenCalledOnce();
            expect(manager.cancelInterrupt).toHaveBeenCalledOnce();
        });

        test("calls unsubscribe on interrupt", async () => {
            const manager = createMockManager("interrupt");
            await lookupViaHost(manager, testCid).catch(() => {});
            expect(manager.unsubscribe).toHaveBeenCalledOnce();
        });

        test("passes correct hex key to manager", async () => {
            const expectedKey = cidToPreimageKey(testCid);
            const manager = createMockManager("resolve");
            await lookupViaHost(manager, testCid);
            expect(manager.lookup).toHaveBeenCalledWith(expectedKey, expect.any(Function));
        });
    });
}
