import { isInsideContainer } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";

import { cidToPreimageKey, computeCid } from "./cid.js";

const log = createLogger("bulletin");

const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;

/** Minimal interface matching `@novasamatech/product-sdk` preimageManager. */
interface PreimageManager {
    lookup(
        key: string,
        callback: (preimage: Uint8Array | null) => void,
    ): { unsubscribe: VoidFunction; onInterrupt: (cb: VoidFunction) => VoidFunction };
}

/**
 * Discriminated union describing how data will be queried from the Bulletin Chain.
 *
 * - `"host-lookup"` — the host manages the lookup via its preimage subscription
 *   API, which includes local caching and managed IPFS polling.
 * - `"gateway"` — direct HTTP fetch from the IPFS gateway.
 */
export type QueryStrategy =
    | { kind: "host-lookup"; lookup: (cid: string, timeoutMs?: number) => Promise<Uint8Array> }
    | { kind: "gateway" };

/**
 * Determine the query strategy for the Bulletin Chain.
 *
 * Resolution order:
 * 1. If running inside a host container (Polkadot Desktop / Mobile) and
 *    `@novasamatech/product-sdk` is available, use the host preimage lookup
 *    API — the host caches results and manages IPFS polling automatically.
 * 2. Otherwise fall back to direct IPFS gateway HTTP fetch.
 *
 * @returns The resolved query strategy.
 */
export async function resolveQueryStrategy(): Promise<QueryStrategy> {
    const inContainer = await isInsideContainer();

    if (inContainer) {
        try {
            const sdk = await import("@novasamatech/product-sdk");
            log.info("inside host container — using preimage lookup for bulletin queries");
            return {
                kind: "host-lookup",
                lookup: (cid, timeoutMs) => lookupViaHost(sdk.preimageManager, cid, timeoutMs),
            };
        } catch {
            log.warn(
                "inside host container but @novasamatech/product-sdk is unavailable, " +
                    "falling back to gateway fetch",
            );
        }
    }

    log.info("using direct IPFS gateway fetch for bulletin queries");
    return { kind: "gateway" };
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
                reject(new Error(`Host preimage lookup timed out after ${timeoutMs}ms for ${key}`));
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
                reject(new Error(`Host preimage lookup interrupted for ${key}`));
            });
        });
    });
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("resolveQueryStrategy", () => {
        test("returns gateway strategy outside container", async () => {
            const strategy = await resolveQueryStrategy();
            expect(strategy.kind).toBe("gateway");
        });

        test("returns host-lookup strategy when inside container with SDK", async () => {
            const fakeWindow = { top: null, __HOST_WEBVIEW_MARK__: true };
            vi.stubGlobal("window", fakeWindow);
            const mockData = new Uint8Array([1, 2, 3]);
            vi.doMock("@novasamatech/product-sdk", () => ({
                preimageManager: {
                    lookup: vi.fn((_key: string, cb: (p: Uint8Array | null) => void) => {
                        queueMicrotask(() => cb(mockData));
                        return {
                            unsubscribe: vi.fn(),
                            onInterrupt: () => vi.fn(),
                        };
                    }),
                },
                sandboxProvider: { isCorrectEnvironment: () => true },
            }));
            try {
                const strategy = await resolveQueryStrategy();
                expect(strategy.kind).toBe("host-lookup");
                if (strategy.kind === "host-lookup") {
                    const cid = computeCid(new TextEncoder().encode("test"));
                    const result = await strategy.lookup(cid, 5000);
                    expect(result).toEqual(mockData);
                }
            } finally {
                vi.doUnmock("@novasamatech/product-sdk");
                vi.unstubAllGlobals();
            }
        });

        test("falls back to gateway when inside container but SDK unavailable", async () => {
            const fakeWindow = { top: null, __HOST_WEBVIEW_MARK__: true };
            vi.stubGlobal("window", fakeWindow);
            vi.doMock("@novasamatech/product-sdk", () => {
                throw new Error("module not found");
            });
            try {
                const strategy = await resolveQueryStrategy();
                expect(strategy.kind).toBe("gateway");
            } finally {
                vi.doUnmock("@novasamatech/product-sdk");
                vi.unstubAllGlobals();
            }
        });
    });

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

            return { lookup, unsubscribe, cancelInterrupt };
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

        test("rejects on timeout", async () => {
            const manager = createMockManager("hang");
            await expect(lookupViaHost(manager, testCid, 50)).rejects.toThrow("timed out");
        });

        test("rejects on interrupt", async () => {
            const manager = createMockManager("interrupt");
            await expect(lookupViaHost(manager, testCid)).rejects.toThrow("interrupted");
        });

        test("calls unsubscribe and cancelInterrupt on resolution", async () => {
            const manager = createMockManager("resolve");
            await lookupViaHost(manager, testCid);
            expect(manager.unsubscribe).toHaveBeenCalledOnce();
            expect(manager.cancelInterrupt).toHaveBeenCalledOnce();
        });

        test("calls unsubscribe on interrupt", async () => {
            const manager = createMockManager("interrupt");
            await expect(lookupViaHost(manager, testCid)).rejects.toThrow("interrupted");
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
