// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * NFT purses of the host, through `truApi.nftPurse`.
 *
 * A purse holds items. An item is an account that can hold an NFT. The host
 * gives a product the public key of each item, and the product uses that
 * public key in its calls. The host does not give the private key to a
 * product. It derives the private key from the user's root entropy when it has
 * to sign, and does not store it.
 *
 * A product needs no permission for its own purses. It needs the
 * `NftPurseRead` permission for a purse that it does not own, and the user
 * confirms every call that moves NFTs out of such a purse.
 *
 * A call that moves NFTs returns when the host has registered the move. The
 * move finishes on chain later. Call `observeOperationStatus` with the
 * idempotency key of the call to get its status.
 *
 * When a host connection reset ends a subscription, the SDK opens it again
 * after the host is connected again. The callback can then get the same
 * update a second time.
 *
 * @module
 */

import type {
    HostNftPurseCreateChequeRequest,
    HostNftPurseCreateItemsRequest,
    HostNftPurseCreatePurseRequest,
    HostNftPurseCreateReceiveKeyRequest,
    HostNftPurseDepositRequest,
    HostNftPurseListPursesRequest,
    HostNftPurseListenOneTimePaymentItem,
    HostNftPurseListenOneTimePaymentRequest,
    HostNftPurseListenPaymentInboxItem,
    HostNftPurseListenPaymentInboxRequest,
    HostNftPurseObserveOperationStatusRequest,
    HostNftPurseQueryPurseRequest,
    HostNftPurseRebalancePurseRequest,
    HostNftPurseRefundRequest,
    HostNftPurseRefundResponse,
    HostNftPurseRevokeChequeRequest,
    HostNftPurseTransferItemRequest,
    NftPurseCheque,
    NftPurseId,
    NftPurseInfoPage,
    NftPurseItemKey,
    NftPursePurse,
    NftPurseReceiveKey,
    NftPurseStatus,
    TrUApiClient,
    X25519PublicKey,
} from "@parity/truapi";

import { getClient, subscribeAcrossResets } from "./transport.js";
import { unwrapHostResult } from "./truapi.js";
import type { HostSubscription } from "./types.js";

/**
 * ID of the main purse. Its owner is `Root`, which means that no product owns
 * it. A product needs a permission from the host to use it.
 */
export const MAIN_NFT_PURSE_ID: NftPurseId = 0xffff_ffff;

/** The max length of a purse name, in UTF-8 bytes. */
export const NFT_PURSE_MAX_NAME_BYTES = 64;

/** The max number of items that one `createItems` call can create. */
export const NFT_PURSE_MAX_ITEMS_PER_CALL = 1000;

/** The max number of items in one `queryPurse` page. */
export const NFT_PURSE_MAX_PAGE_SIZE = 100;

/** The final status of an NFT move operation. */
export type TerminalNftPurseStatus = Extract<NftPurseStatus, { tag: "Cleared" | "Incomplete" }>;

/**
 * Returns true when an operation is finished. `Cleared` means every NFT moved
 * in a finalized block. `Incomplete` means some moves failed.
 */
export function isNftPurseOperationFinished(
    status: NftPurseStatus,
): status is TerminalNftPurseStatus {
    return status.tag === "Cleared" || status.tag === "Incomplete";
}

/**
 * The NFT purse calls of the host. A call that fails throws an `Error` with the
 * host's error as `cause`, and {@link hostErrorName} returns the name of that
 * error.
 */
export interface NftPurseManager {
    /**
     * Creates a purse for this product and returns its id. The host allows
     * duplicate purses. Call `listPurses` first to make sure that your purse
     * does not already exist.
     */
    createPurse(request: HostNftPurseCreatePurseRequest): Promise<NftPurseId>;
    /**
     * Returns the purses of an owner. The `NftPurseRead` permission is needed
     * for the purses of another product or of Root.
     */
    listPurses(request: HostNftPurseListPursesRequest): Promise<NftPursePurse[]>;
    /**
     * Creates new items in a purse and returns their public keys. One call
     * creates up to {@link NFT_PURSE_MAX_ITEMS_PER_CALL} items.
     */
    createItems(request: HostNftPurseCreateItemsRequest): Promise<NftPurseItemKey[]>;
    /**
     * Returns one page of the items that hold an NFT on chain and are not in
     * use. The first page is 0, and a page has up to
     * {@link NFT_PURSE_MAX_PAGE_SIZE} items.
     */
    queryPurse(request: HostNftPurseQueryPurseRequest): Promise<NftPurseInfoPage>;
    /**
     * Moves NFTs from items of one purse to new items of another purse. A
     * second call with the same idempotency key fails with `OperationExists`.
     */
    rebalancePurse(request: HostNftPurseRebalancePurseRequest): Promise<void>;
    /** Moves the NFT of one item to a public key outside the purses. */
    transferItem(request: HostNftPurseTransferItemRequest): Promise<void>;
    /**
     * Calls `onStatus` with the status of an operation until the operation is
     * finished. Use the idempotency key of a rebalance or a transfer, or the
     * cheque id of a deposit. For a revoke use
     * `blake2_256("nft-purse/revoke" ‖ chequeId)`, and for a refund
     * `blake2_256("nft-purse/refund" ‖ chequeId)`.
     */
    observeOperationStatus(
        request: HostNftPurseObserveOperationStatusRequest,
        onStatus: (status: NftPurseStatus) => void,
    ): HostSubscription;
    /**
     * Creates a cheque for items and returns it. The product sends the cheque
     * to the recipient. The purse cannot use these items after this call. A
     * second cheque with the same id fails with `OperationExists`.
     */
    createCheque(request: HostNftPurseCreateChequeRequest): Promise<NftPurseCheque>;
    /**
     * Cancels a cheque that this product created. The host moves the NFTs to
     * new items of the purse they came from. After that the private keys in
     * the cheque cannot move the NFTs.
     */
    revokeCheque(request: HostNftPurseRevokeChequeRequest): Promise<void>;
    /**
     * Moves the NFTs of a received cheque to new items of a purse. The cheque
     * id is the idempotency key.
     */
    deposit(request: HostNftPurseDepositRequest): Promise<void>;
    /**
     * Moves the NFTs of a deposited cheque back to the public keys in the
     * cheque. Returns the items that the host started to move back and the
     * items that were spent after the deposit.
     */
    refund(request: HostNftPurseRefundRequest): Promise<HostNftPurseRefundResponse>;
    /**
     * Returns the X25519 public key that senders encrypt `Static` cheques to.
     * Every product gets the same one. The user has to agree to disclose their
     * identity before the host returns it.
     */
    staticReceiveKey(): Promise<X25519PublicKey>;
    /**
     * Subscribes to `Static` cheques sent to one inbox of this product. Every
     * time the subscription opens, the callback first gets the channel, which
     * has the statement store topic of the inbox. Then it gets all cheques
     * that the statement store still has, including deposited ones, so ignore
     * the cheque ids that are already deposited. After that the callback gets
     * new cheques.
     */
    listenPaymentInbox(
        request: HostNftPurseListenPaymentInboxRequest,
        onUpdate: (update: HostNftPurseListenPaymentInboxItem) => void,
    ): HostSubscription;
    /** Creates a one-time receive public key for a purse. The product gives it to the sender. */
    createReceiveKey(request: HostNftPurseCreateReceiveKeyRequest): Promise<NftPurseReceiveKey>;
    /**
     * Subscribes to the cheque sent to a receive public key of this product.
     * The callback first gets the channel, which has the statement store topic
     * for that receive public key. Then it gets the cheque, and the
     * subscription ends.
     */
    listenOneTimePayment(
        request: HostNftPurseListenOneTimePaymentRequest,
        onUpdate: (update: HostNftPurseListenOneTimePaymentItem) => void,
    ): HostSubscription;
}

function adaptNftPurseManager(client: TrUApiClient): NftPurseManager {
    const nftPurse = client.nftPurse;
    return {
        async createPurse(request) {
            const created = await unwrapHostResult(
                nftPurse.createPurse(request),
                "nftPurse createPurse failed",
            );
            return created.purse;
        },
        async listPurses(request) {
            const listed = await unwrapHostResult(
                nftPurse.listPurses(request),
                "nftPurse listPurses failed",
            );
            return listed.purses;
        },
        async createItems(request) {
            const created = await unwrapHostResult(
                nftPurse.createItems(request),
                "nftPurse createItems failed",
            );
            return created.items;
        },
        async queryPurse(request) {
            const read = await unwrapHostResult(
                nftPurse.queryPurse(request),
                "nftPurse queryPurse failed",
            );
            return read.page;
        },
        rebalancePurse(request) {
            return unwrapHostResult(
                nftPurse.rebalancePurse(request),
                "nftPurse rebalancePurse failed",
            );
        },
        transferItem(request) {
            return unwrapHostResult(nftPurse.transferItem(request), "nftPurse transferItem failed");
        },
        observeOperationStatus(request, onStatus) {
            return subscribeAcrossResets(
                () => nftPurse.observeOperationStatus({ request }),
                onStatus,
            );
        },
        async createCheque(request) {
            const created = await unwrapHostResult(
                nftPurse.createCheque(request),
                "nftPurse createCheque failed",
            );
            return created.cheque;
        },
        revokeCheque(request) {
            return unwrapHostResult(nftPurse.revokeCheque(request), "nftPurse revokeCheque failed");
        },
        deposit(request) {
            return unwrapHostResult(nftPurse.deposit(request), "nftPurse deposit failed");
        },
        refund(request) {
            return unwrapHostResult(nftPurse.refund(request), "nftPurse refund failed");
        },
        async staticReceiveKey() {
            const disclosed = await unwrapHostResult(
                nftPurse.staticReceiveKey({}),
                "nftPurse staticReceiveKey failed",
            );
            return disclosed.key;
        },
        listenPaymentInbox(request, onUpdate) {
            return subscribeAcrossResets(() => nftPurse.listenPaymentInbox({ request }), onUpdate);
        },
        async createReceiveKey(request) {
            const created = await unwrapHostResult(
                nftPurse.createReceiveKey(request),
                "nftPurse createReceiveKey failed",
            );
            return created.key;
        },
        listenOneTimePayment(request, onUpdate) {
            return subscribeAcrossResets(
                () => nftPurse.listenOneTimePayment({ request }),
                onUpdate,
            );
        },
    };
}

/**
 * Returns the NFT purse manager, or `null` outside a host. On a host that has
 * no NFT purses every call fails with `Unsupported`.
 *
 * @example
 * ```ts
 * import {
 *   getNftPurseManager,
 *   isNftPurseOperationFinished,
 *   NFT_PURSE_MAX_PAGE_SIZE,
 *   toHex,
 * } from "@parity/product-sdk-host";
 *
 * const purses = await getNftPurseManager();
 * if (purses) {
 *   const purse = await purses.createPurse({ name: "collectibles" });
 *   const [mintTarget] = await purses.createItems({ purse, count: 1 });
 *   // ...mint an NFT to `mintTarget` on chain...
 *
 *   const { items } = await purses.queryPurse({
 *     purse,
 *     page: 0,
 *     pageSize: NFT_PURSE_MAX_PAGE_SIZE,
 *   });
 *
 *   const archive = await purses.createPurse({ name: "archive" });
 *   const idempotencyKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
 *   await purses.rebalancePurse({ from: purse, to: archive, keys: items, idempotencyKey });
 *   const move = purses.observeOperationStatus({ idempotencyKey }, (status) => {
 *     if (isNftPurseOperationFinished(status)) move.unsubscribe();
 *   });
 * }
 * ```
 */
export async function getNftPurseManager(): Promise<NftPurseManager | null> {
    const client = await getClient();
    return client ? adaptNftPurseManager(client) : null;
}

if (import.meta.vitest) {
    const { afterEach, describe, expect, test } = import.meta.vitest;
    const { errAsync, okAsync } = await import("neverthrow");
    const { hostErrorName } = await import("./errors.js");
    const { emitConnectionStatus, setTruApiClient } = await import("./transport.js");

    type HostObserver = {
        next: (update: unknown) => void;
        error: (reason: unknown) => void;
        complete: () => void;
    };

    const ANSWERING_CALLS = [
        "createPurse",
        "listPurses",
        "createItems",
        "queryPurse",
        "rebalancePurse",
        "transferItem",
        "createCheque",
        "revokeCheque",
        "deposit",
        "refund",
        "staticReceiveKey",
        "createReceiveKey",
    ] as const;
    const SUBSCRIPTIONS = [
        "observeOperationStatus",
        "listenPaymentInbox",
        "listenOneTimePayment",
    ] as const;

    function stubHost(
        hostAnswers: Record<string, unknown> = {},
        hostErrors: Record<string, unknown> = {},
    ) {
        const calls: Array<[string, unknown]> = [];
        const hostObservers = new Map<string, HostObserver>();

        const answering = (name: string) => (request: unknown) => {
            calls.push([name, request]);
            return name in hostErrors ? errAsync(hostErrors[name]) : okAsync(hostAnswers[name]);
        };
        const subscribing = (name: string) => (request: unknown) => {
            calls.push([name, request]);
            return {
                subscribe(observer: HostObserver) {
                    hostObservers.set(name, observer);
                    return { unsubscribe: () => {}, subscriptionId: name };
                },
            };
        };
        const nftPurse = Object.fromEntries([
            ...ANSWERING_CALLS.map((name) => [name, answering(name)]),
            ...SUBSCRIPTIONS.map((name) => [name, subscribing(name)]),
        ]);

        const client = { nftPurse } as unknown as TrUApiClient;
        return { client, manager: adaptNftPurseManager(client), calls, hostObservers };
    }

    const purse = 7;
    const otherPurse = 8;
    const itemKey = `0x${"a1".repeat(32)}` as const;
    const receiveKey = `0x${"b2".repeat(32)}` as const;
    const chequeId = `0x${"c3".repeat(32)}` as const;
    const idempotencyKey = `0x${"d4".repeat(32)}` as const;
    const inboxDomain = `0x${"e5".repeat(32)}` as const;
    const cheque: NftPurseCheque = {
        version: 0,
        id: chequeId,
        recipient: { tag: "Static" },
        items: [itemKey],
        encryptedSecrets: "0xee",
    };

    const subscribeTo = {
        observeOperationStatus: (manager: NftPurseManager, onUpdate: (update: unknown) => void) =>
            manager.observeOperationStatus({ idempotencyKey }, onUpdate),
        listenPaymentInbox: (manager: NftPurseManager, onUpdate: (update: unknown) => void) =>
            manager.listenPaymentInbox({ inboxDomain }, onUpdate),
        listenOneTimePayment: (manager: NftPurseManager, onUpdate: (update: unknown) => void) =>
            manager.listenOneTimePayment({ key: receiveKey }, onUpdate),
    };

    afterEach(() => setTruApiClient(null));

    test("getNftPurseManager returns null outside a container", async () => {
        expect(await getNftPurseManager()).toBeNull();
    });

    test("getNftPurseManager returns a manager inside a host", async () => {
        const { client, calls } = stubHost({ createPurse: { purse } });
        setTruApiClient(client);

        const purses = await getNftPurseManager();

        expect(await purses?.createPurse({ name: "stash" })).toBe(purse);
        expect(calls).toEqual([["createPurse", { name: "stash" }]]);
    });

    test("isNftPurseOperationFinished is true for Cleared and Incomplete", () => {
        const reference = { root: chequeId, leaves: [] };
        const statuses: NftPurseStatus[] = [
            { tag: "InProgress" },
            { tag: "Clearing", value: { cleared: [] } },
            { tag: "Cleared", value: { cleared: [], reference } },
            { tag: "Incomplete", value: { cleared: [], failed: [itemKey], reference } },
        ];
        expect(statuses.map(isNftPurseOperationFinished)).toEqual([false, false, true, true]);
    });

    describe("adaptNftPurseManager", () => {
        const stashPurse = { id: purse, name: "stash" };
        const page = { hasNext: false, items: [itemKey] };
        const refunded = { started: [itemKey], unavailable: [] };
        const toReceiveKey = { tag: "Ephemeral", value: receiveKey };

        test.each([
            {
                call: "createPurse",
                request: { name: "stash" },
                hostAnswer: { purse },
                answer: purse,
            },
            {
                call: "listPurses",
                request: { owner: { tag: "Root" } },
                hostAnswer: { purses: [stashPurse] },
                answer: [stashPurse],
            },
            {
                call: "createItems",
                request: { purse, count: 1 },
                hostAnswer: { items: [itemKey] },
                answer: [itemKey],
            },
            {
                call: "queryPurse",
                request: { purse, page: 0, pageSize: NFT_PURSE_MAX_PAGE_SIZE },
                hostAnswer: { page },
                answer: page,
            },
            {
                call: "rebalancePurse",
                request: { from: purse, to: otherPurse, keys: [itemKey], idempotencyKey },
            },
            {
                call: "transferItem",
                request: { item: itemKey, destination: receiveKey, idempotencyKey },
            },
            {
                call: "createCheque",
                request: { from: purse, to: toReceiveKey, items: [itemKey] },
                hostAnswer: { cheque },
                answer: cheque,
            },
            { call: "revokeCheque", request: { chequeId } },
            { call: "deposit", request: { cheque, to: purse } },
            { call: "refund", request: { chequeId }, hostAnswer: refunded, answer: refunded },
            {
                call: "createReceiveKey",
                request: { into: purse },
                hostAnswer: { key: receiveKey },
                answer: receiveKey,
            },
        ])(
            "$call passes the request to the host and returns the answer",
            async ({ call, request, hostAnswer, answer }) => {
                const { manager, calls } = stubHost({ [call]: hostAnswer });
                const askHost = manager[call as keyof NftPurseManager] as (
                    request: unknown,
                ) => Promise<unknown>;

                expect(await askHost(request)).toEqual(answer);
                expect(calls).toEqual([[call, request]]);
            },
        );

        test("staticReceiveKey sends an empty request", async () => {
            const { manager, calls } = stubHost({ staticReceiveKey: { key: receiveKey } });

            expect(await manager.staticReceiveKey()).toBe(receiveKey);
            expect(calls).toEqual([["staticReceiveKey", {}]]);
        });

        test("a failed call throws an Error with the host's error as cause", async () => {
            const operationExists = {
                tag: "Domain",
                value: { tag: "V1", value: { tag: "OperationExists" } },
            };
            const { manager } = stubHost({}, { deposit: operationExists });

            const thrown = await manager.deposit({ cheque, to: purse }).catch((error) => error);

            expect(thrown.message).toBe("nftPurse deposit failed: OperationExists");
            expect(thrown.cause).toBe(operationExists);
            expect(hostErrorName(thrown)).toBe("OperationExists");
        });

        test("a call fails with Unsupported on a host without NFT purses", async () => {
            const { manager } = stubHost({}, { listPurses: { tag: "Unsupported" } });

            const thrown = await manager
                .listPurses({ owner: { tag: "Root" } })
                .catch((error) => error);

            expect(hostErrorName(thrown)).toBe("Unsupported");
        });

        test("each subscription is opened with its request", () => {
            const { manager, calls } = stubHost();

            for (const name of SUBSCRIPTIONS) subscribeTo[name](manager, () => {});

            expect(calls).toEqual([
                ["observeOperationStatus", { request: { idempotencyKey } }],
                ["listenPaymentInbox", { request: { inboxDomain } }],
                ["listenOneTimePayment", { request: { key: receiveKey } }],
            ]);
        });

        test.each(SUBSCRIPTIONS)("%s passes what the host sends to the callback", (name) => {
            const { manager, hostObservers } = stubHost();
            const received: unknown[] = [];
            subscribeTo[name](manager, (update) => received.push(update));

            hostObservers.get(name)?.next("first update");
            hostObservers.get(name)?.next("second update");

            expect(received).toEqual(["first update", "second update"]);
        });

        test.each(SUBSCRIPTIONS)(
            "%s calls onInterrupt when the host ends the subscription",
            (name) => {
                const { manager, hostObservers } = stubHost();
                const reasons: unknown[] = [];
                subscribeTo[name](manager, () => {}).onInterrupt((reason) => reasons.push(reason));

                hostObservers.get(name)?.complete();

                expect(reasons).toEqual([undefined]);
            },
        );

        test("onInterrupt gets the host's error when the host ends a subscription with one", () => {
            const operationNotFound = {
                tag: "Domain",
                value: { tag: "V1", value: { tag: "OperationNotFound" } },
            };
            const { manager, hostObservers } = stubHost();
            const reasons: unknown[] = [];
            const subscription = subscribeTo.observeOperationStatus(manager, () => {});
            subscription.onInterrupt((reason) => reasons.push(reason));

            hostObservers.get("observeOperationStatus")?.error(operationNotFound);

            expect(reasons).toEqual([operationNotFound]);
            expect(hostErrorName(reasons[0])).toBe("OperationNotFound");
        });

        test.each(SUBSCRIPTIONS)("%s is opened again after a host connection reset", (name) => {
            const { client, manager, calls, hostObservers } = stubHost();
            setTruApiClient(client);
            const reasons: unknown[] = [];
            const subscription = subscribeTo[name](manager, () => {});
            subscription.onInterrupt((reason) => reasons.push(reason));

            const connectionReset = Object.assign(new Error("reset"), {
                name: "ConnectionResetError",
            });
            hostObservers.get(name)?.error(connectionReset);
            emitConnectionStatus("disconnected");
            emitConnectionStatus("connected");

            expect(calls.map(([call]) => call)).toEqual([name, name]);
            expect(reasons).toEqual([]);
            subscription.unsubscribe();
        });
    });
}
