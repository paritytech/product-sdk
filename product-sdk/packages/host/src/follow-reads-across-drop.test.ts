// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Does a read made across a host link drop reach the new follow of the caller?
 *
 * The provider only holds a read. Sending it again is the job of
 * `withStopRecovery` in polkadot-api, so this runs the real polkadot-api client
 * over `createHostPapiProvider` and fakes only the truapi chain domain.
 *
 * @module
 */

import { ConnectionResetError } from "@parity/truapi";
import type { TrUApiClient } from "@parity/truapi";
import { Blake2256, blockHeader } from "@polkadot-api/substrate-bindings";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { createClient } from "polkadot-api";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createHostPapiProvider } from "./papi-provider.js";
import { toHex } from "./truapi.js";

const CODE_KEY = "0x3a636f6465";
const header = blockHeader.enc({
    parentHash: `0x${"00".repeat(32)}`,
    number: 7,
    stateRoot: `0x${"11".repeat(32)}`,
    extrinsicRoot: `0x${"22".repeat(32)}`,
    digests: [],
});
const blockHash = toHex(Blake2256(header));

type Observer = {
    next: (item: unknown) => void;
    error: (error: unknown) => void;
    complete: () => void;
};
type BodyAnswer = () => ResultAsync<unknown, unknown>;

function deferredResult() {
    let reject: (error: unknown) => void = () => {};
    const pending = new Promise<never>((_resolve, rejectPending) => {
        reject = rejectPending;
    });
    return { result: new ResultAsync(pending), reject };
}

/** The truapi chain domain, answering every follow and read from one block. */
function fakeHost(answers: BodyAnswer[]) {
    const follows: Array<{ id: string; observer: Observer; unsubscribe: () => void }> = [];
    const bodyReadsOn: string[] = [];
    let operations = 0;

    const emit = (followId: string, item: unknown) =>
        setTimeout(() => follows.find((follow) => follow.id === followId)?.observer.next(item), 0);
    const started = (operationId: string) =>
        okAsync({ operation: { tag: "Started", value: { operationId } } });

    const chain = {
        followHeadSubscribe: () => ({
            subscribe: (observer: Observer) => {
                const id = `p:${follows.length + 1}`;
                const unsubscribe = vi.fn();
                follows.push({ id, observer, unsubscribe });
                return { subscriptionId: id, unsubscribe };
            },
        }),
        getHeadHeader: () => okAsync({ header: toHex(header) }),
        getHeadStorage: ({ followSubscriptionId }: { followSubscriptionId: string }) => {
            const operationId = `code-${++operations}`;
            emit(followSubscriptionId, {
                tag: "OperationStorageItems",
                value: { operationId, items: [{ key: CODE_KEY, hash: "0xc0de" }] },
            });
            emit(followSubscriptionId, { tag: "OperationStorageDone", value: { operationId } });
            return started(operationId);
        },
        getHeadBody: ({ followSubscriptionId }: { followSubscriptionId: string }) => {
            bodyReadsOn.push(followSubscriptionId);
            const answer = answers.shift();
            if (answer) return answer();
            const operationId = `body-${++operations}`;
            emit(followSubscriptionId, {
                tag: "OperationBodyDone",
                value: { operationId, value: ["0x0102"] },
            });
            return started(operationId);
        },
        callHead: () => new ResultAsync(new Promise<never>(() => {})),
        unpinHead: () => okAsync(undefined),
        stopHeadOperation: () => okAsync(undefined),
        continueHead: () => okAsync(undefined),
    };

    return {
        client: { chain } as unknown as TrUApiClient,
        follows,
        bodyReadsOn,
        announceBlock(index: number) {
            const { observer } = follows[index]!;
            observer.next({ tag: "Initialized", value: { finalizedBlockHashes: [blockHash] } });
        },
        bestBlock(index: number) {
            const { observer } = follows[index]!;
            observer.next({ tag: "BestBlockChanged", value: { bestBlockHash: blockHash } });
        },
    };
}

const openClients: ReturnType<typeof createClient>[] = [];

/** A real polkadot-api client whose follow on the fake host has `blockHash` ready. */
async function readyClient(answers: BodyAnswer[] = []) {
    vi.useFakeTimers();
    const host = fakeHost(answers);
    const papi = createClient(createHostPapiProvider(host.client, "0xfeed"));
    openClients.push(papi);
    const settle = () => vi.advanceTimersByTimeAsync(5);
    const followReady = async (index: number) => {
        host.announceBlock(index);
        await settle();
        host.bestBlock(index);
        await settle();
    };
    await settle();
    await followReady(0);
    return { ...host, papi, settle, followReady };
}

/** The state of a read, read back without waiting on it. */
function watch<T>(read: Promise<T>) {
    const state: { value?: T; error?: unknown } = {};
    read.then(
        (value) => {
            state.value = value;
        },
        (error) => {
            state.error = error;
        },
    );
    return state;
}

const BODY = [Uint8Array.from([1, 2])];

afterEach(() => {
    for (const papi of openClients.splice(0)) papi.destroy();
    vi.useRealTimers();
});

describe("a read across a host link drop works", () => {
    test("in flight when the link drops resolves from the new follow", async () => {
        const inFlight = deferredResult();
        const c = await readyClient([() => inFlight.result]);

        const read = watch(c.papi.getBlockBody(blockHash));
        await c.settle();
        expect(c.bodyReadsOn).toEqual(["p:1"]);

        const reset = new ConnectionResetError();
        c.follows[0]!.observer.error(reset);
        inFlight.reject(reset);
        await c.settle();
        expect(read.error).toBeUndefined();

        await vi.advanceTimersByTimeAsync(250);
        expect(c.follows).toHaveLength(2);
        await c.followReady(1);

        expect(c.bodyReadsOn).toEqual(["p:1", "p:2"]);
        expect(read.error).toBeUndefined();
        expect(read.value).toEqual(BODY);
    });

    test("sent while the stop is pending never reaches the host on the old follow", async () => {
        const c = await readyClient();

        c.follows[0]!.observer.error(new ConnectionResetError());
        await c.settle();
        const read = watch(c.papi.getBlockBody(blockHash));
        await c.settle();
        expect(c.bodyReadsOn).toEqual([]);
        expect(read.error).toBeUndefined();

        await vi.advanceTimersByTimeAsync(250);
        await c.followReady(1);

        expect(c.bodyReadsOn).toEqual(["p:2"]);
        expect(read.value).toEqual(BODY);
    });

    test.each([
        ["unknown follow subscription id", 'unknown follow subscription id "c4:host:10"'],
        ["ended", 'follow subscription "c4:host:10" ended when its connection closed'],
        ["stopped", 'follow subscription "c4:host:10" was stopped by the node'],
    ])(
        "answered %s while its stream looks alive stops that follow and resolves from the new one",
        async (_label, reason) => {
            const c = await readyClient([
                () =>
                    errAsync({
                        tag: "HostFailure",
                        value: { reason: `remote_chain_head_body: ${reason}` },
                    }),
            ]);

            const read = watch(c.papi.getBlockBody(blockHash));
            await c.settle();
            expect(read.error).toBeUndefined();
            expect(c.follows[0]!.unsubscribe).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(250);
            await c.followReady(1);

            expect(c.bodyReadsOn).toEqual(["p:1", "p:2"]);
            expect(read.value).toEqual(BODY);
        },
    );
});

describe("a read across a host link drop fails", () => {
    test("answered with any other host error still fails the caller at once", async () => {
        const c = await readyClient([
            () => errAsync({ tag: "HostFailure", value: { reason: "no such block" } }),
        ]);

        const read = watch(c.papi.getBlockBody(blockHash));
        await c.settle();

        expect(String(read.error)).toContain("no such block");
        expect(c.follows).toHaveLength(1);
    });
});
