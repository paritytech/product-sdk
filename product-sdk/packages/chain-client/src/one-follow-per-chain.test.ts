// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Does a product that asks for one chain through two configs follow it once?
 *
 * The host allows a product few `chainHead_v1_follow`s per chain and polkadot-api
 * holds one per client, so this runs the real polkadot-api client over the host's
 * provider, fakes only the truapi chain domain, and counts the follows that reach
 * it. The fake host mirrors the one in the host package's
 * `follow-reads-across-drop.test.ts`.
 *
 * @module
 */

import { Blake2256, blockHeader } from "@polkadot-api/substrate-bindings";
import { Binary, type ChainDefinition } from "polkadot-api";
import { afterEach, expect, test, vi } from "vitest";
import { configure } from "@parity/product-sdk-logger";
import { setTruApiClient } from "@parity/product-sdk-host/testing";

import { createChainClient, destroyAll } from "./clients.js";

type TruApiClient = Parameters<typeof setTruApiClient>[0] & object;
type Observer = { next: (item: unknown) => void; error: (error: unknown) => void };
type StorageItem = { key: string; queryType: string };

const toHex = (bytes: Uint8Array) => Binary.toHex(bytes);
const header = blockHeader.enc({
    parentHash: `0x${"00".repeat(32)}`,
    number: 7,
    stateRoot: `0x${"11".repeat(32)}`,
    extrinsicRoot: `0x${"22".repeat(32)}`,
    digests: [],
});
const blockHash = toHex(Blake2256(header));
const BODY = [Uint8Array.from([1, 2])];

/** A host `ResultAsync`, as far as the host package reads one. */
const ok = <T>(value: T) => ({ match: (onOk: (value: T) => unknown) => onOk(value) });

/** The truapi chain domain, answering every follow and read from one block. */
function fakeHost() {
    const follows: Array<{ id: string; observer: Observer; genesisHash: string }> = [];
    let operations = 0;

    const emit = (followId: string, item: unknown) =>
        setTimeout(() => follows.find((follow) => follow.id === followId)?.observer.next(item), 0);
    const started = (operationId: string) =>
        ok({ operation: { tag: "Started", value: { operationId } } });

    const chain = {
        followHeadSubscribe: ({ request }: { request: { genesisHash: string } }) => ({
            subscribe: (observer: Observer) => {
                const id = `p:${follows.length + 1}`;
                follows.push({ id, observer, genesisHash: request.genesisHash });
                return { subscriptionId: id, unsubscribe: () => {} };
            },
        }),
        getHeadHeader: () => ok({ header: toHex(header) }),
        getHeadStorage: ({
            followSubscriptionId,
            items,
        }: {
            followSubscriptionId: string;
            items: StorageItem[];
        }) => {
            const operationId = `storage-${++operations}`;
            emit(followSubscriptionId, {
                tag: "OperationStorageItems",
                value: {
                    operationId,
                    items: items.map(({ key, queryType }) =>
                        queryType === "Hash" ? { key, hash: "0xc0de" } : { key, value: "0x2a" },
                    ),
                },
            });
            emit(followSubscriptionId, { tag: "OperationStorageDone", value: { operationId } });
            return started(operationId);
        },
        getHeadBody: ({ followSubscriptionId }: { followSubscriptionId: string }) => {
            const operationId = `body-${++operations}`;
            emit(followSubscriptionId, {
                tag: "OperationBodyDone",
                value: { operationId, value: ["0x0102"] },
            });
            return started(operationId);
        },
        callHead: () => ({ match: () => new Promise<never>(() => {}) }),
        unpinHead: () => ok(undefined),
        stopHeadOperation: () => ok(undefined),
        continueHead: () => ok(undefined),
    };
    const system = { featureSupported: () => ok({ supported: true }) };

    return {
        client: { chain, system } as unknown as TruApiClient,
        follows,
        followsOf: (genesisHash: string) =>
            follows.filter((follow) => follow.genesisHash === genesisHash),
        /** Bring every follow opened so far to a finalized and best block. */
        async announceBlocks() {
            for (const { observer } of follows) {
                observer.next({ tag: "Initialized", value: { finalizedBlockHashes: [blockHash] } });
            }
            await settle();
            for (const { observer } of follows) {
                observer.next({ tag: "BestBlockChanged", value: { bestBlockHash: blockHash } });
            }
            await settle();
        },
    };
}

const settle = () => vi.advanceTimersByTimeAsync(5);

const errors: string[] = [];
configure({
    level: "error",
    handler: (entry) => errors.push(entry.message),
});

afterEach(() => {
    destroyAll();
    setTruApiClient(null);
    vi.useRealTimers();
    errors.length = 0;
});

/** A descriptor for `genesis` whose metadata never arrives: the typed API is never used here. */
const descriptor = (genesis: `0x${string}`) =>
    ({
        genesis,
        descriptors: new Promise(() => {}),
        metadataTypes: new Promise(() => {}),
    }) as unknown as ChainDefinition;
const people = descriptor("0xfeed");
const assetHub = descriptor("0xa55e");
const bulletin = descriptor("0xb011");

test("two configs sharing a chain, each used for a read, follow it once", async () => {
    vi.useFakeTimers();
    const host = fakeHost();
    setTruApiClient(host.client);

    const [a, b] = await Promise.all([
        createChainClient({ chains: { people, assetHub } }),
        createChainClient({ chains: { people, bulletin } }),
    ]);
    await settle();
    await host.announceBlocks();

    // A read through each config, over the chain they share. (A storage query
    // through the typed API would first need metadata, which this host does not
    // serve; polkadot-api's own runtime detection already queries storage on
    // the follow.)
    const readA = a.raw.people.getBlockBody(blockHash);
    const readB = b.raw.people.getBlockBody(blockHash);
    await settle();
    expect(await readA).toEqual(BODY);
    expect(await readB).toEqual(BODY);
    expect(host.followsOf("0xfeed")).toHaveLength(1);
    // The chains only one config uses are each followed once.
    expect(host.followsOf("0xa55e")).toHaveLength(1);
    expect(host.followsOf("0xb011")).toHaveLength(1);
    expect(errors).toEqual([]);

    // Releasing one config keeps the shared follow for the other.
    a.destroy();
    const readAfter = b.raw.people.getBlockBody(blockHash);
    await settle();
    expect(await readAfter).toEqual(BODY);
    expect(host.followsOf("0xfeed")).toHaveLength(1);
    expect(errors).toEqual([]);
});

test("a chain the host refuses stays out of the way of the chain two configs share", async () => {
    vi.useFakeTimers();
    const host = fakeHost();
    const unsupported = descriptor("0xdead");
    host.client.system.featureSupported = (({ value }: { value: { genesisHash: string } }) =>
        ok({ supported: value.genesisHash !== "0xdead" })) as never;
    setTruApiClient(host.client);

    const a = await createChainClient({ chains: { people } });
    const b = await createChainClient({ chains: { people, unsupported } });
    await settle();
    await host.announceBlocks();

    const read = b.raw.people.getBlockBody(blockHash);
    await settle();
    expect(await read).toEqual(BODY);
    expect(() => (b as { unsupported: { query: unknown } }).unsupported.query).toThrow(
        /not supported/,
    );
    expect(a.raw.people).toBe(b.raw.people);
    expect(host.follows).toHaveLength(1);
    expect(errors).toEqual([]);
});
