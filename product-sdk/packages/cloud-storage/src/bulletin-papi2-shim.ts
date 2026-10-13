// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Lets `@parity/bulletin-sdk` 0.3.0, built for PAPI 2, submit through a PAPI 3 client.
 *
 * That release calls `tx.signSubmitAndWatch(signer)` on every transaction it
 * builds from the typed API, and reads the PAPI 2 event names. PAPI 3 renamed
 * the method to `createSubmitAndWatch` and split the events. This wraps the
 * typed API so each transaction also answers the old method, translating the
 * events back. Delete it once a bulletin-sdk release built for PAPI 3 ships.
 *
 * @module
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";

interface Observer {
    next?: (event: unknown) => void;
    error?: (error: unknown) => void;
    complete?: () => void;
}

interface Papi3Tx {
    createSubmitAndWatch(creator: CommonSignerTxCreator): {
        subscribe(observer: Observer): { unsubscribe(): void };
    };
}

/** A PAPI 3 transaction event in the shape bulletin-sdk 0.3.0 reads. */
export function toPapi2Event(event: { type: string; txHash?: string }): unknown {
    switch (event.type) {
        case "created":
            return { ...event, type: "signed" };
        case "inBestBlock":
            return { ...event, type: "txBestBlocksState", found: true };
        case "notInBestBlock":
            return { ...event, type: "txBestBlocksState", found: false };
        default:
            return event;
    }
}

function withSignSubmitAndWatch<T extends object>(tx: T): T {
    if (!("createSubmitAndWatch" in tx)) return tx;
    const papi3 = tx as unknown as Papi3Tx;
    return Object.assign(Object.create(tx) as T, {
        signSubmitAndWatch: (creator: CommonSignerTxCreator) => ({
            subscribe: (observer: Observer) =>
                papi3.createSubmitAndWatch(creator).subscribe({
                    next: (event) => observer.next?.(toPapi2Event(event as { type: string })),
                    error: (error) => observer.error?.(error),
                    complete: () => observer.complete?.(),
                }),
        }),
    });
}

/** Wrap a PAPI 3 typed API so every `tx.<Pallet>.<call>(…)` also has `signSubmitAndWatch`. */
export function withBulletinPapi2Tx<Api extends { tx: object }>(api: Api): Api {
    const tx = new Proxy(api.tx, {
        get(pallets, palletName, receiver) {
            const pallet = Reflect.get(pallets, palletName, receiver);
            if (pallet === undefined || pallet === null || typeof pallet !== "object") {
                return pallet;
            }
            return new Proxy(pallet, {
                get(calls, callName, callReceiver) {
                    const call = Reflect.get(calls, callName, callReceiver);
                    if (typeof call !== "function") return call;
                    return (...args: unknown[]) => {
                        const built = call.apply(calls, args);
                        return built && typeof built === "object"
                            ? withSignSubmitAndWatch(built)
                            : built;
                    };
                },
            });
        },
    });
    return new Proxy(api, {
        get(target, key, receiver) {
            return key === "tx" ? tx : Reflect.get(target, key, receiver);
        },
    });
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;

    function fakeApi(events: Array<{ type: string; txHash?: string }>) {
        const createSubmitAndWatch = vi.fn(() => ({
            subscribe: (observer: Observer) => {
                for (const event of events) observer.next?.(event);
                observer.complete?.();
                return { unsubscribe: () => {} };
            },
        }));
        const store = vi.fn((..._args: unknown[]) => ({
            decodedCall: { pallet: "store" },
            createSubmitAndWatch,
        }));
        return {
            api: { tx: { TransactionStorage: { store } }, query: { marker: 1 } },
            store,
            createSubmitAndWatch,
        };
    }

    const signer = {} as CommonSignerTxCreator;

    describe("withBulletinPapi2Tx", () => {
        test("translates the PAPI 3 events to the names bulletin-sdk 0.3.0 reads", () => {
            const { api, createSubmitAndWatch } = fakeApi([
                { type: "created", txHash: "0x01" },
                { type: "broadcasted", txHash: "0x01" },
                { type: "notInBestBlock", txHash: "0x01" },
                { type: "inBestBlock", txHash: "0x01" },
                { type: "finalized", txHash: "0x01" },
            ]);
            const seen: unknown[] = [];
            const tx = withBulletinPapi2Tx(api).tx.TransactionStorage.store() as unknown as {
                signSubmitAndWatch(c: CommonSignerTxCreator): {
                    subscribe(o: Observer): unknown;
                };
            };
            tx.signSubmitAndWatch(signer).subscribe({ next: (event) => seen.push(event) });
            expect(createSubmitAndWatch).toHaveBeenCalledWith(signer);
            expect(seen).toEqual([
                { type: "signed", txHash: "0x01" },
                { type: "broadcasted", txHash: "0x01" },
                { type: "txBestBlocksState", txHash: "0x01", found: false },
                { type: "txBestBlocksState", txHash: "0x01", found: true },
                { type: "finalized", txHash: "0x01" },
            ]);
        });

        test("keeps the call arguments, the decoded call and the rest of the API", () => {
            const { api, store } = fakeApi([]);
            const wrapped = withBulletinPapi2Tx(api);
            const tx = wrapped.tx.TransactionStorage.store({ data: 1 } as never) as unknown as {
                decodedCall: unknown;
            };
            expect(store).toHaveBeenCalledWith({ data: 1 });
            expect(tx.decodedCall).toEqual({ pallet: "store" });
            expect(wrapped.query).toBe(api.query);
        });

        test("a pallet the chain lacks stays undefined, as bulletin-sdk checks for Sudo", () => {
            const { api } = fakeApi([]);
            expect((withBulletinPapi2Tx(api).tx as Record<string, unknown>).Sudo).toBeUndefined();
        });

        test("forwards errors from the PAPI 3 subscription", () => {
            const boom = new Error("dropped");
            const tx = withBulletinPapi2Tx({
                tx: {
                    P: {
                        c: () => ({
                            createSubmitAndWatch: () => ({
                                subscribe: (observer: Observer) => {
                                    observer.error?.(boom);
                                    return { unsubscribe: () => {} };
                                },
                            }),
                        }),
                    },
                },
            }).tx.P.c() as unknown as {
                signSubmitAndWatch(c: CommonSignerTxCreator): {
                    subscribe(o: Observer): unknown;
                };
            };
            const error = vi.fn();
            tx.signSubmitAndWatch(signer).subscribe({ error });
            expect(error).toHaveBeenCalledWith(boom);
        });
    });
}
