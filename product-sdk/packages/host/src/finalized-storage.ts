// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Reading chain storage at the latest finalized block through the host, without
 * polkadot-api.
 *
 * A worker that needs a handful of storage values (a username, a chat key) does
 * not need a full chain client: this follows the chain's head through the host's
 * chainHead-style calls and reads values at the newest finalized block. One
 * follow is kept per reader and restarted after it ends.
 *
 * @module
 */
import type {
    ChainIdentifier,
    HexString,
    RemoteChainHeadFollowItem,
    TrUApiClient,
} from "@parity/truapi";
import { type Clock, systemClock } from "@parity/product-sdk-utils";

import { formatHostError } from "./errors.js";
import { getClient } from "./transport.js";
import { fromHex, toHex, unwrapHostResult } from "./truapi.js";

/** How long a follow may take to report its first finalized block, and a read its items, before failing. */
export const FINALIZED_READ_TIMEOUT_MS = 20_000;

/** Reads storage values of one chain at its latest finalized block. */
export interface FinalizedStorageReader {
    /** The value under `key`, or `undefined` when the key holds none. */
    read(key: Uint8Array): Promise<Uint8Array | undefined>;
}

type Follow = { genesisHash: HexString; subscriptionId: string };
type Items = Map<string, HexString | undefined>;

class HostFinalizedStorageReader implements FinalizedStorageReader {
    private follow: Promise<Follow> | undefined;
    private finalized: HexString | undefined;
    private readonly waiters = new Map<string, (items: Items) => void>();
    private readonly pending = new Map<string, Items>();
    /** Operations that ended before their read started waiting: follow events arrive on their own task. */
    private readonly finished = new Map<string, Items>();
    private initialized: (() => void) | undefined;

    constructor(
        private readonly client: TrUApiClient,
        private readonly chain: ChainIdentifier,
        private readonly clock: Clock,
    ) {}

    async read(key: Uint8Array): Promise<Uint8Array | undefined> {
        const { genesisHash, subscriptionId } = await this.ensureFollow();
        const hash = this.finalized;
        if (!hash) throw new Error("no finalized block yet");
        const started = await unwrapHostResult(
            this.client.chain.getHeadStorage({
                genesisHash,
                followSubscriptionId: subscriptionId,
                hash,
                items: [{ key: toHex(key), queryType: "Value" }],
            }),
            "chain getHeadStorage failed",
        );
        if (started.operation.tag !== "Started") throw new Error("storage operation limit reached");
        const operationId = started.operation.value.operationId;
        const items = await new Promise<Items>((resolve, reject) => {
            const early = this.finished.get(operationId);
            if (early) {
                this.finished.delete(operationId);
                resolve(early);
                return;
            }
            this.waiters.set(operationId, resolve);
            void this.clock.sleep(FINALIZED_READ_TIMEOUT_MS).then(() => {
                if (this.waiters.delete(operationId)) reject(new Error("storage read timed out"));
            });
        });
        const value = items.get(toHex(key));
        return value ? fromHex(value) : undefined;
    }

    private ensureFollow(): Promise<Follow> {
        this.follow ??= this.startFollow().catch((error: unknown) => {
            // Not kept: the next read starts a new follow, as a dropped connection needs.
            this.follow = undefined;
            throw error;
        });
        return this.follow;
    }

    private async startFollow(): Promise<Follow> {
        const info = await unwrapHostResult(
            this.client.chain.getChainInfo({ chain: this.chain }),
            "chain getChainInfo failed",
        );
        let fail: (error: Error) => void = () => {};
        const ready = new Promise<void>((resolve, reject) => {
            this.initialized = resolve;
            fail = reject;
        });
        const subscription = this.client.chain
            .followHeadSubscribe({ request: { genesisHash: info.genesisHash, withRuntime: false } })
            .subscribe({
                next: (item) => this.onFollow(item),
                error: (error) => {
                    this.follow = undefined;
                    fail(new Error(`chain follow failed: ${formatHostError(error)}`));
                },
                complete: () => {
                    this.follow = undefined;
                    fail(new Error("chain follow ended"));
                },
            });
        void this.clock
            .sleep(FINALIZED_READ_TIMEOUT_MS)
            .then(() => fail(new Error("the chain gave no finalized block")));
        try {
            await ready;
        } catch (error) {
            subscription.unsubscribe();
            throw error;
        }
        return { genesisHash: info.genesisHash, subscriptionId: subscription.subscriptionId };
    }

    private onFollow(item: RemoteChainHeadFollowItem): void {
        switch (item.tag) {
            case "Initialized":
            case "Finalized": {
                const hashes = item.value.finalizedBlockHashes;
                const last = hashes[hashes.length - 1];
                if (last) this.finalized = last;
                if (item.tag === "Initialized") this.initialized?.();
                return;
            }
            case "OperationStorageItems": {
                const map = this.pending.get(item.value.operationId) ?? new Map();
                for (const entry of item.value.items) map.set(entry.key, entry.value);
                this.pending.set(item.value.operationId, map);
                return;
            }
            case "OperationWaitingForContinue": {
                void this.follow?.then(({ genesisHash, subscriptionId }) =>
                    this.client.chain.continueHead({
                        genesisHash,
                        followSubscriptionId: subscriptionId,
                        operationId: item.value.operationId,
                    }),
                );
                return;
            }
            case "OperationStorageDone":
            case "OperationInaccessible":
            case "OperationError": {
                const id = item.value.operationId;
                const items = this.pending.get(id) ?? new Map();
                this.pending.delete(id);
                const waiter = this.waiters.get(id);
                if (waiter) {
                    this.waiters.delete(id);
                    waiter(items);
                } else {
                    this.finished.set(id, items);
                }
                return;
            }
            case "Stop":
                this.follow = undefined;
                return;
            default:
                return;
        }
    }
}

/** A {@link FinalizedStorageReader} of `chain` on `client`. */
export function createFinalizedStorageReader(
    client: TrUApiClient,
    chain: ChainIdentifier,
    clock: Clock = systemClock,
): FinalizedStorageReader {
    return new HostFinalizedStorageReader(client, chain, clock);
}

/**
 * A {@link FinalizedStorageReader} of `chain`, or `null` outside a container.
 *
 * @example
 * ```ts
 * import { getFinalizedStorageReader } from "@parity/product-sdk-host";
 *
 * const assetHub = await getFinalizedStorageReader("AssetHub");
 * const value = await assetHub?.read(storageKey);
 * ```
 */
export async function getFinalizedStorageReader(
    chain: ChainIdentifier,
    clock?: Clock,
): Promise<FinalizedStorageReader | null> {
    const client = await getClient();
    return client ? createFinalizedStorageReader(client, chain, clock) : null;
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { okAsync } = await import("neverthrow");
    const { ManualClock, settle } = await import("@parity/product-sdk-utils/testing");

    const key = new Uint8Array(32).fill(1);
    const outcome = (read: Promise<unknown>) =>
        read.then(
            () => "read",
            (error: Error) => error.message,
        );

    test("a chain that gives no finalized block fails the read, and the next read follows again", async () => {
        // A phone on a bad connection: the host never reports the first block. A read must
        // end with an error rather than wait for ever, and must try again later.
        const clock = new ManualClock();
        let follows = 0;
        const client = {
            chain: {
                getChainInfo: () => okAsync({ genesisHash: `0x${"11".repeat(32)}` }),
                followHeadSubscribe: () => {
                    follows++;
                    return {
                        subscriptionId: `f${follows}`,
                        subscribe: () => ({ unsubscribe() {} }),
                    };
                },
            },
        } as unknown as TrUApiClient;
        const reader = createFinalizedStorageReader(client, "AssetHub", clock);

        const first = outcome(reader.read(key));
        await settle(5);
        await clock.advance(FINALIZED_READ_TIMEOUT_MS);
        expect(await first).toBe("the chain gave no finalized block");

        const second = outcome(reader.read(key));
        await settle(5);
        expect(follows).toBe(2);
        await clock.advance(FINALIZED_READ_TIMEOUT_MS);
        expect(await second).toBe("the chain gave no finalized block");
    });

    test("a read whose items arrive before the host answers the read call still resolves", async () => {
        // The core forwards follow events on their own task, so a short read can finish before its call returns.
        const hexKey = `0x${"01".repeat(32)}`;
        let emit: (item: unknown) => void = () => {};
        const client = {
            chain: {
                getChainInfo: () => okAsync({ genesisHash: `0x${"11".repeat(32)}` }),
                followHeadSubscribe: () => ({
                    subscriptionId: "f1",
                    subscribe: (observer: { next: (item: unknown) => void }) => {
                        emit = observer.next;
                        queueMicrotask(() =>
                            emit({
                                tag: "Initialized",
                                value: { finalizedBlockHashes: [`0x${"22".repeat(32)}`] },
                            }),
                        );
                        return { unsubscribe() {} };
                    },
                }),
                getHeadStorage: () => {
                    emit({
                        tag: "OperationStorageItems",
                        value: { operationId: "op1", items: [{ key: hexKey, value: "0x2a" }] },
                    });
                    emit({ tag: "OperationStorageDone", value: { operationId: "op1" } });
                    return okAsync({
                        operation: { tag: "Started", value: { operationId: "op1" } },
                    });
                },
            },
        } as unknown as TrUApiClient;
        const reader = createFinalizedStorageReader(client, "AssetHub", new ManualClock());
        expect(await reader.read(key)).toEqual(new Uint8Array([0x2a]));
    });

    test("getFinalizedStorageReader returns null outside a container", async () => {
        expect(await getFinalizedStorageReader("AssetHub")).toBeNull();
    });
}
