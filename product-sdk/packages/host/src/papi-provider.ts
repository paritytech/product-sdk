// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Host-routed PAPI `JsonRpcProvider`, backed by `truApi.chain.*`.
 *
 * This is a backport of `@novasamatech/host-api-wrapper`'s
 * `createPapiProvider` (`dist/papiProvider.js`) into product-sdk, with the
 * call layer swapped from the novasama `hostApi` to the
 * `@parity/truapi` client. The JSON-RPC ↔ chainHead bridge handles request
 * dispatch, `chainHead_v1_followEvent` notification synthesis, and operation /
 * broadcast bookkeeping over the structured `truApi.chain.*` methods.
 *
 * **Why a bridge at all.** PAPI speaks the JSON-RPC `chainHead`/`chainSpec`/
 * `transaction` API; the host exposes the same operations as structured,
 * SCALE-typed calls. This module parses each inbound JSON-RPC message, routes it
 * to the matching `truApi.chain` method, and translates the typed follow stream
 * back into JSON-RPC notifications.
 *
 * **Divergences from the upstream:**
 * - No `getSyncProvider` wrapper / no-op fallback provider. The upstream had to
 *   defer its async readiness check because `createPapiProvider` was synchronous;
 *   here {@link module:container.getHostProvider} is async and runs the
 *   `system.featureSupported` gate (throwing `ChainNotSupportedError`) *before*
 *   building the provider, so there is no async work left to defer.
 * - `RuntimeSpec.apis` arrives as `Array<{ name, version }>` (truapi) rather than
 *   the upstream's `[name, version]` tuples; {@link convertRuntimeToJsonRpc}
 *   adjusts the loop accordingly.
 * - The follow stream's transport interrupt (`error`/`complete`) is surfaced as a
 *   synthetic `stop` event so the consumer's substrate-client refollows; the
 *   upstream's bare callback had no such channel.
 *
 * @module
 */

import type {
    JsonRpcConnection,
    JsonRpcMessage,
    JsonRpcRequest,
} from "@polkadot-api/json-rpc-provider";
import type { JsonRpcProvider } from "polkadot-api";
import type {
    HexString,
    OperationStartedResult,
    RemoteChainHeadFollowItem,
    RuntimeType,
    StorageQueryType,
    TrUApiClient,
} from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import { formatHostError } from "./errors.js";
import { subscribeWithInterrupt, type TransportSubscription } from "./transport.js";

const log = createLogger("host:papi");

/** JSON-RPC internal-error code used for every host-side failure (matches the upstream). */
const JSON_RPC_INTERNAL_ERROR = -32603;
/** JSON-RPC method-not-found code for chainHead methods the host doesn't serve. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** A `chainHead_v1_followEvent` payload (loosely typed — consumed by PAPI's substrate-client). */
type FollowEvent = { event: string } & Record<string, unknown>;

type BufferedOperation = {
    announced: boolean;
    items: RemoteChainHeadFollowItem[];
};

/** Return the operation id carried by an operation follow item. */
function followOperationId(item: RemoteChainHeadFollowItem): string | undefined {
    switch (item.tag) {
        case "OperationBodyDone":
        case "OperationCallDone":
        case "OperationStorageItems":
        case "OperationStorageDone":
        case "OperationWaitingForContinue":
        case "OperationInaccessible":
        case "OperationError":
            return item.value.operationId;
        default:
            return undefined;
    }
}

/** Whether this item closes its operation. */
function isTerminalOperationItem(item: RemoteChainHeadFollowItem): boolean {
    return (
        item.tag === "OperationBodyDone" ||
        item.tag === "OperationCallDone" ||
        item.tag === "OperationStorageDone" ||
        item.tag === "OperationInaccessible" ||
        item.tag === "OperationError"
    );
}

/** Map a JSON-RPC storage query-type string to the truapi `StorageQueryType` tag. */
const STORAGE_TYPE_MAP: Record<string, StorageQueryType> = {
    value: "Value",
    hash: "Hash",
    closestDescendantMerkleValue: "ClosestDescendantMerkleValue",
    descendantsValues: "DescendantsValues",
    descendantsHashes: "DescendantsHashes",
};

/**
 * Convert a truapi `RuntimeType` into the JSON-RPC `chainHead` runtime shape.
 * Returns `null` for absent/unknown runtimes. Note `RuntimeSpec.apis` is an
 * array of `{ name, version }` (truapi), flattened here into a `{ name: version }`
 * map as the JSON-RPC spec expects.
 */
function convertRuntimeToJsonRpc(runtime: RuntimeType | undefined): unknown {
    if (!runtime || typeof runtime !== "object") return null;
    if (runtime.tag === "Valid") {
        const spec = runtime.value;
        const apis: Record<string, number> = {};
        for (const api of spec.apis) {
            apis[api.name] = api.version;
        }
        return {
            type: "valid",
            spec: {
                specName: spec.specName,
                implName: spec.implName,
                specVersion: spec.specVersion,
                implVersion: spec.implVersion,
                transactionVersion: spec.transactionVersion,
                apis,
            },
        };
    }
    if (runtime.tag === "Invalid") {
        return { type: "invalid", error: runtime.value.error };
    }
    return null;
}

/** Translate a typed follow-stream item into its JSON-RPC `followEvent` form. */
function convertFollowEventToJsonRpc(item: RemoteChainHeadFollowItem): FollowEvent {
    switch (item.tag) {
        case "Initialized":
            return {
                event: "initialized",
                finalizedBlockHashes: item.value.finalizedBlockHashes,
                finalizedBlockRuntime: convertRuntimeToJsonRpc(item.value.finalizedBlockRuntime),
            };
        case "NewBlock":
            return {
                event: "newBlock",
                blockHash: item.value.blockHash,
                parentBlockHash: item.value.parentBlockHash,
                newRuntime: convertRuntimeToJsonRpc(item.value.newRuntime),
            };
        case "BestBlockChanged":
            return { event: "bestBlockChanged", bestBlockHash: item.value.bestBlockHash };
        case "Finalized":
            return {
                event: "finalized",
                finalizedBlockHashes: item.value.finalizedBlockHashes,
                prunedBlockHashes: item.value.prunedBlockHashes,
            };
        case "OperationBodyDone":
            return {
                event: "operationBodyDone",
                operationId: item.value.operationId,
                value: item.value.value,
            };
        case "OperationCallDone":
            return {
                event: "operationCallDone",
                operationId: item.value.operationId,
                output: item.value.output,
            };
        case "OperationStorageItems":
            return {
                event: "operationStorageItems",
                operationId: item.value.operationId,
                items: item.value.items,
            };
        case "OperationStorageDone":
            return { event: "operationStorageDone", operationId: item.value.operationId };
        case "OperationWaitingForContinue":
            return { event: "operationWaitingForContinue", operationId: item.value.operationId };
        case "OperationInaccessible":
            return { event: "operationInaccessible", operationId: item.value.operationId };
        case "OperationError":
            return {
                event: "operationError",
                operationId: item.value.operationId,
                error: item.value.error,
            };
        case "Stop":
            return { event: "stop" };
        default: {
            // Exhaustiveness: a new follow-item tag in @parity/truapi fails to compile here.
            const _exhaustive: never = item;
            return { event: "stop" };
        }
    }
}

/** Map a JSON-RPC storage query-type string to the truapi `StorageQueryType` tag. */
function convertStorageType(type: string): StorageQueryType {
    return STORAGE_TYPE_MAP[type] ?? "Value";
}

/** Translate a truapi `OperationStartedResult` into the JSON-RPC operation-start shape. */
function convertOperationResultToJsonRpc(result: OperationStartedResult): unknown {
    if (result.tag === "Started") {
        return { result: "started", operationId: result.value.operationId };
    }
    return { result: "limitReached" };
}

/**
 * Build a host-routed PAPI `JsonRpcProvider` for `genesisHash` over the given
 * TruAPI client. The caller is responsible for confirming the host supports the
 * chain (and for the handshake) before calling this — see
 * {@link module:container.getHostProvider}.
 */
export function createHostPapiProvider(
    client: TrUApiClient,
    genesisHash: HexString,
): JsonRpcProvider {
    const chain = client.chain;

    return (onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection => {
        const activeFollows = new Map<string, TransportSubscription>();
        const activeBroadcasts = new Set<string>();
        const followOperations = new Map<string, Map<string, BufferedOperation>>();
        const pendingOperationStarts = new Map<string, number>();

        function sendJsonRpcResponse(id: JsonRpcRequest["id"], result: unknown): void {
            onMessage({ jsonrpc: "2.0", id, result } as JsonRpcMessage);
        }
        function sendJsonRpcError(id: JsonRpcRequest["id"], code: number, message: string): void {
            onMessage({ jsonrpc: "2.0", id, error: { code, message } } as JsonRpcMessage);
        }
        function sendFollowEvent(subscription: string, event: FollowEvent): void {
            onMessage({
                jsonrpc: "2.0",
                method: "chainHead_v1_followEvent",
                params: { subscription, result: event },
            } as JsonRpcMessage);
        }

        function forwardFollowItem(
            followSubscriptionId: string,
            item: RemoteChainHeadFollowItem,
        ): void {
            const operationId = followOperationId(item);
            if (operationId === undefined) {
                sendFollowEvent(followSubscriptionId, convertFollowEventToJsonRpc(item));
                return;
            }

            const operations = followOperations.get(followSubscriptionId);
            if (!operations) return;

            let operation = operations.get(operationId);
            if (!operation) {
                // A missing entry also means the operation already ended — the spec and
                // PAPI's cancel path still emit then. With no start outstanding nothing
                // can announce those, so buffering would strand them until unfollow.
                if ((pendingOperationStarts.get(followSubscriptionId) ?? 0) === 0) {
                    sendFollowEvent(followSubscriptionId, convertFollowEventToJsonRpc(item));
                    return;
                }
                operation = { announced: false, items: [] };
                operations.set(operationId, operation);
            }
            if (!operation.announced) {
                operation.items.push(item);
                return;
            }

            sendFollowEvent(followSubscriptionId, convertFollowEventToJsonRpc(item));
            if (isTerminalOperationItem(item)) {
                operations.delete(operationId);
            }
        }

        function sendOperationStartedResponse(
            id: JsonRpcRequest["id"],
            followSubscriptionId: string,
            result: OperationStartedResult,
        ): void {
            // The JSON-RPC response must be observable before any event naming its
            // operation. TrUAPI request and subscription frames are independent,
            // so a fast operation can complete before this request resolves.
            sendJsonRpcResponse(id, convertOperationResultToJsonRpc(result));
            if (result.tag !== "Started") return;

            const operations = followOperations.get(followSubscriptionId);
            if (!operations) return;

            const operationId = result.value.operationId;
            let operation = operations.get(operationId);
            if (!operation) {
                operation = { announced: true, items: [] };
                operations.set(operationId, operation);
                return;
            }

            operation.announced = true;
            const pendingItems = operation.items;
            operation.items = [];
            for (const item of pendingItems) {
                forwardFollowItem(followSubscriptionId, item);
            }
        }

        // Both arms must clear the count: a failed start never sends `Started`, and a
        // stuck count buffers forever.
        function startOperationRequest(id: JsonRpcRequest["id"], followSubscriptionId: string) {
            const pending = pendingOperationStarts.get(followSubscriptionId);
            if (pending !== undefined) {
                pendingOperationStarts.set(followSubscriptionId, pending + 1);
            }
            const settle = () => {
                const outstanding = pendingOperationStarts.get(followSubscriptionId);
                if (outstanding === undefined) return;
                pendingOperationStarts.set(followSubscriptionId, Math.max(0, outstanding - 1));
            };
            return {
                ok: (response: { operation: OperationStartedResult }) => {
                    settle();
                    sendOperationStartedResponse(id, followSubscriptionId, response.operation);
                },
                err: (error: unknown) => {
                    settle();
                    hostError(id)(error);
                },
            };
        }

        /** Reject an inbound request with the host's error reason as the JSON-RPC message. */
        const hostError = (id: JsonRpcRequest["id"]) => (error: unknown) =>
            sendJsonRpcError(id, JSON_RPC_INTERNAL_ERROR, formatHostError(error));

        function handleMessage(message: JsonRpcRequest): void {
            const { id, method } = message;
            // chainHead/chainSpec/transaction JSON-RPC params are positional arrays.
            const params = (message.params ?? []) as unknown[];

            switch (method) {
                case "chainHead_v1_follow": {
                    const [withRuntime] = params as [boolean];
                    // The Stop branch unsubscribes its own host subscription, but the
                    // handle is this call's return value — the ref breaks that
                    // chicken-and-egg. (Releasing before forwarding the Stop is just
                    // cleanup; the consumer's synchronous refollow gets a fresh wire
                    // subscription either way.)
                    const ref: { handle?: TransportSubscription } = {};
                    const pendingItems: RemoteChainHeadFollowItem[] = [];
                    const forwardItem = (
                        followSubscriptionId: string,
                        item: RemoteChainHeadFollowItem,
                    ) => {
                        if (item.tag === "Stop" && activeFollows.delete(followSubscriptionId)) {
                            ref.handle?.unsubscribe();
                            followOperations.delete(followSubscriptionId);
                            pendingOperationStarts.delete(followSubscriptionId);
                        }
                        forwardFollowItem(followSubscriptionId, item);
                    };
                    ref.handle = subscribeWithInterrupt(
                        chain.followHeadSubscribe({ request: { genesisHash, withRuntime } }),
                        (item) => {
                            const followSubscriptionId = ref.handle?.subscriptionId;
                            if (!followSubscriptionId) {
                                pendingItems.push(item);
                                return;
                            }
                            forwardItem(followSubscriptionId, item);
                        },
                    );
                    const followSubscriptionId = ref.handle.subscriptionId;
                    if (!followSubscriptionId) {
                        ref.handle.unsubscribe();
                        sendJsonRpcError(
                            id,
                            JSON_RPC_INTERNAL_ERROR,
                            "Host follow subscription did not start",
                        );
                        break;
                    }
                    // A transport interrupt/close ends the stream without a Stop
                    // item; synthesize one so the consumer refollows.
                    ref.handle.onInterrupt(() => {
                        followOperations.delete(followSubscriptionId);
                        pendingOperationStarts.delete(followSubscriptionId);
                        if (activeFollows.delete(followSubscriptionId)) {
                            sendFollowEvent(followSubscriptionId, { event: "stop" });
                        }
                    });
                    activeFollows.set(followSubscriptionId, ref.handle);
                    followOperations.set(followSubscriptionId, new Map());
                    pendingOperationStarts.set(followSubscriptionId, 0);
                    sendJsonRpcResponse(id, followSubscriptionId);
                    for (const item of pendingItems) {
                        forwardItem(followSubscriptionId, item);
                    }
                    break;
                }
                case "chainHead_v1_unfollow": {
                    const [followSubId] = params as [string];
                    const follow = activeFollows.get(followSubId);
                    if (follow) {
                        follow.unsubscribe();
                        activeFollows.delete(followSubId);
                    }
                    followOperations.delete(followSubId);
                    pendingOperationStarts.delete(followSubId);
                    sendJsonRpcResponse(id, null);
                    break;
                }
                case "chainHead_v1_header": {
                    const [followSubscriptionId, hash] = params as [string, HexString];
                    chain
                        .getHeadHeader({ genesisHash, followSubscriptionId, hash })
                        .match(
                            (response) => sendJsonRpcResponse(id, response.header ?? null),
                            hostError(id),
                        );
                    break;
                }
                case "chainHead_v1_body": {
                    const [followSubscriptionId, hash] = params as [string, HexString];
                    const bodyStart = startOperationRequest(id, followSubscriptionId);
                    chain
                        .getHeadBody({ genesisHash, followSubscriptionId, hash })
                        .match(bodyStart.ok, bodyStart.err);
                    break;
                }
                case "chainHead_v1_storage": {
                    const [followSubscriptionId, hash, items, childTrie] = params as [
                        string,
                        HexString,
                        Array<{ key: HexString; type: string }>,
                        HexString | undefined,
                    ];
                    const queryItems = items.map((item) => ({
                        key: item.key,
                        queryType: convertStorageType(item.type),
                    }));
                    const storageStart = startOperationRequest(id, followSubscriptionId);
                    chain
                        .getHeadStorage({
                            genesisHash,
                            followSubscriptionId,
                            hash,
                            items: queryItems,
                            // PAPI passes `null` for an absent child trie, but the
                            // truapi codec encodes the optional `childTrie` field as
                            // `Option<Hex>` — it treats `undefined` as None yet runs
                            // the inner Hex codec on `null`, which throws
                            // (`null.startsWith`). Coerce `null` → `undefined`.
                            childTrie: childTrie ?? undefined,
                        })
                        .match(storageStart.ok, storageStart.err);
                    break;
                }
                case "chainHead_v1_call": {
                    const [followSubscriptionId, hash, fn, callParameters] = params as [
                        string,
                        HexString,
                        string,
                        HexString,
                    ];
                    const callStart = startOperationRequest(id, followSubscriptionId);
                    chain
                        .callHead({
                            genesisHash,
                            followSubscriptionId,
                            hash,
                            function: fn,
                            callParameters,
                        })
                        .match(callStart.ok, callStart.err);
                    break;
                }
                case "chainHead_v1_unpin": {
                    const [followSubscriptionId, hashOrHashes] = params as [
                        string,
                        HexString | HexString[],
                    ];
                    const hashes = Array.isArray(hashOrHashes) ? hashOrHashes : [hashOrHashes];
                    chain
                        .unpinHead({ genesisHash, followSubscriptionId, hashes })
                        .match(() => sendJsonRpcResponse(id, null), hostError(id));
                    break;
                }
                case "chainHead_v1_continue": {
                    const [followSubscriptionId, operationId] = params as [string, string];
                    chain
                        .continueHead({ genesisHash, followSubscriptionId, operationId })
                        .match(() => sendJsonRpcResponse(id, null), hostError(id));
                    break;
                }
                case "chainHead_v1_stopOperation": {
                    const [followSubscriptionId, operationId] = params as [string, string];
                    chain
                        .stopHeadOperation({ genesisHash, followSubscriptionId, operationId })
                        .match(() => {
                            followOperations.get(followSubscriptionId)?.delete(operationId);
                            sendJsonRpcResponse(id, null);
                        }, hostError(id));
                    break;
                }
                case "chainSpec_v1_genesisHash": {
                    chain
                        .getSpecGenesisHash({ genesisHash })
                        .match(
                            (response) => sendJsonRpcResponse(id, response.genesisHash),
                            hostError(id),
                        );
                    break;
                }
                case "chainSpec_v1_chainName": {
                    chain
                        .getSpecChainName({ genesisHash })
                        .match(
                            (response) => sendJsonRpcResponse(id, response.chainName),
                            hostError(id),
                        );
                    break;
                }
                case "chainSpec_v1_properties": {
                    chain.getSpecProperties({ genesisHash }).match((response) => {
                        try {
                            sendJsonRpcResponse(id, JSON.parse(response.properties));
                        } catch {
                            sendJsonRpcResponse(id, response.properties);
                        }
                    }, hostError(id));
                    break;
                }
                case "transaction_v1_broadcast": {
                    const [transaction] = params as [HexString];
                    chain.broadcastTransaction({ genesisHash, transaction }).match((response) => {
                        const operationId = response.operationId ?? null;
                        if (operationId !== null) activeBroadcasts.add(operationId);
                        sendJsonRpcResponse(id, operationId);
                    }, hostError(id));
                    break;
                }
                case "transaction_v1_stop": {
                    const [operationId] = params as [string];
                    activeBroadcasts.delete(operationId);
                    chain
                        .stopTransaction({ genesisHash, operationId })
                        .match(() => sendJsonRpcResponse(id, null), hostError(id));
                    break;
                }
                default:
                    sendJsonRpcError(
                        id,
                        JSON_RPC_METHOD_NOT_FOUND,
                        `Method "${method}" is not supported by the host`,
                    );
                    break;
            }
        }

        return {
            send(message) {
                // A synchronous throw inside a handler (e.g. a malformed positional
                // param) must not leave the JSON-RPC request unsettled — the caller
                // would hang. Surface it as an error response for the request id.
                try {
                    handleMessage(message);
                } catch (error) {
                    // Handlers must settle the request themselves; reaching here means a
                    // synchronous throw before any response was sent. (A handler that
                    // sends then throws would double-respond — none do today.)
                    log.warn("send: handler threw before settling the request", {
                        error: formatHostError(error),
                    });
                    sendJsonRpcError(message.id, JSON_RPC_INTERNAL_ERROR, formatHostError(error));
                }
            },
            disconnect() {
                for (const handle of activeFollows.values()) {
                    handle.unsubscribe();
                }
                activeFollows.clear();
                followOperations.clear();
                pendingOperationStarts.clear();
                for (const operationId of activeBroadcasts) {
                    // Fire-and-forget: the transport may already be torn down.
                    chain.stopTransaction({ genesisHash, operationId }).match(
                        () => {},
                        () => {},
                    );
                }
                activeBroadcasts.clear();
            },
        };
    };
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;

    // A minimal fake of the truapi chain domain. ResultAsync is approximated by a
    // `.match(ok, err)` thenable; the follow subscription is a hand-driven
    // ObservableLike whose observer we capture to push items at will.
    function makeFakeClient(opts: {
        onCall?: (method: string, args: unknown) => void;
        responses?: Record<string, unknown>;
        /** Methods named here resolve to their `.match` error arm carrying the given value. */
        errors?: Record<string, unknown>;
        /** Capture selected successful matches so tests can resolve them after follow events. */
        deferMatch?: (method: string, resolve: () => unknown) => boolean;
        /** Unsubscribe spy used by the follow subscription (defaults to a fresh `vi.fn()`). */
        unsubscribe?: () => void;
        /** Item emitted synchronously while the transport subscription starts. */
        initialItem?: unknown;
        captureObserver?: (observer: {
            next: (i: unknown) => void;
            error: (e: unknown) => void;
            complete: () => void;
        }) => void;
        /** Transport request id assigned to the follow subscription. */
        subscriptionId?: string;
    }) {
        const errMatch = (error: unknown) => ({
            match: (_ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => err(error),
        });
        const method = (name: string, response: unknown) => (args: unknown) => {
            opts.onCall?.(name, args);
            const errors = opts.errors ?? {};
            if (name in errors) return errMatch(errors[name]);
            return {
                match: (ok: (value: unknown) => unknown, _err: (error: unknown) => unknown) => {
                    const resolve = () => ok(response);
                    if (opts.deferMatch?.(name, resolve)) return undefined;
                    return resolve();
                },
            };
        };
        return {
            chain: {
                followHeadSubscribe: (_args: unknown) => ({
                    subscribe: (observer: {
                        next: (i: unknown) => void;
                        error: (e: unknown) => void;
                        complete: () => void;
                    }) => {
                        opts.captureObserver?.(observer);
                        if (opts.initialItem !== undefined) {
                            observer.next(opts.initialItem);
                        }
                        return {
                            subscriptionId: opts.subscriptionId ?? "p:41",
                            unsubscribe: opts.unsubscribe ?? vi.fn(),
                        };
                    },
                    [Symbol.observable as symbol]() {
                        return this;
                    },
                }),
                getHeadHeader: method(
                    "getHeadHeader",
                    opts.responses?.getHeadHeader ?? { header: "0x01" },
                ),
                getHeadBody: method(
                    "getHeadBody",
                    opts.responses?.getHeadBody ?? {
                        operation: { tag: "Started", value: { operationId: "op1" } },
                    },
                ),
                getHeadStorage: method(
                    "getHeadStorage",
                    opts.responses?.getHeadStorage ?? { operation: { tag: "LimitReached" } },
                ),
                callHead: method(
                    "callHead",
                    opts.responses?.callHead ?? {
                        operation: { tag: "Started", value: { operationId: "op2" } },
                    },
                ),
                unpinHead: method("unpinHead", undefined),
                continueHead: method("continueHead", undefined),
                stopHeadOperation: method("stopHeadOperation", undefined),
                getSpecGenesisHash: method("getSpecGenesisHash", { genesisHash: "0xabc" }),
                getSpecChainName: method("getSpecChainName", { chainName: "Polkadot" }),
                getSpecProperties: method("getSpecProperties", { properties: '{"ss58Format":0}' }),
                broadcastTransaction: method("broadcastTransaction", { operationId: "bc1" }),
                stopTransaction: method("stopTransaction", undefined),
            },
        } as unknown as TrUApiClient;
    }

    test("follow preserves the transport id for events and follow-up requests", () => {
        let observer:
            | { next: (i: unknown) => void; error: (e: unknown) => void; complete: () => void }
            | undefined;
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({
            subscriptionId: "p:17",
            onCall: (method, args) => calls.push([method, args]),
            captureObserver: (o) => {
                observer = o;
            },
        });
        const provider = createHostPapiProvider(client, "0xfeed");

        const messages: JsonRpcMessage[] = [];
        const conn = provider((m) => messages.push(m));

        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: "p:17" });

        // A typed BestBlockChanged item becomes a chainHead_v1_followEvent.
        observer?.next({ tag: "BestBlockChanged", value: { bestBlockHash: "0xbeef" } });
        expect(messages[1]).toEqual({
            jsonrpc: "2.0",
            method: "chainHead_v1_followEvent",
            params: {
                subscription: "p:17",
                result: { event: "bestBlockChanged", bestBlockHash: "0xbeef" },
            },
        });

        conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_header",
            params: ["p:17", "0xbeef"],
        });
        expect(calls).toContainEqual([
            "getHeadHeader",
            {
                genesisHash: "0xfeed",
                followSubscriptionId: "p:17",
                hash: "0xbeef",
            },
        ]);
    });

    test("follow buffers an item emitted while the transport subscription starts", () => {
        const client = makeFakeClient({
            subscriptionId: "p:18",
            initialItem: { tag: "BestBlockChanged", value: { bestBlockHash: "0xbeef" } },
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((message) => messages.push(message));

        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });

        expect(messages).toEqual([
            { jsonrpc: "2.0", id: 1, result: "p:18" },
            {
                jsonrpc: "2.0",
                method: "chainHead_v1_followEvent",
                params: {
                    subscription: "p:18",
                    result: { event: "bestBlockChanged", bestBlockHash: "0xbeef" },
                },
            },
        ]);
    });

    test("buffers a call completion until after its operation-start response", () => {
        let observer:
            | { next: (i: unknown) => void; error: (e: unknown) => void; complete: () => void }
            | undefined;
        let resolveCall: (() => unknown) | undefined;
        const client = makeFakeClient({
            responses: {
                callHead: { operation: { tag: "Started", value: { operationId: "op-call" } } },
            },
            captureObserver: (value) => {
                observer = value;
            },
            deferMatch: (method, resolve) => {
                if (method !== "callHead") return false;
                resolveCall = resolve;
                return true;
            },
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((message) => messages.push(message));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [false] });
        messages.length = 0;

        conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_call",
            params: ["p:41", "0xhash", "Test_call", "0x"],
        });
        observer?.next({
            tag: "OperationCallDone",
            value: { operationId: "op-call", output: "0x1234" },
        });
        expect(messages).toEqual([]);

        resolveCall?.();
        expect(messages).toEqual([
            {
                jsonrpc: "2.0",
                id: 2,
                result: { result: "started", operationId: "op-call" },
            },
            {
                jsonrpc: "2.0",
                method: "chainHead_v1_followEvent",
                params: {
                    subscription: "p:41",
                    result: {
                        event: "operationCallDone",
                        operationId: "op-call",
                        output: "0x1234",
                    },
                },
            },
        ]);
    });

    test("preserves buffered storage item order after announcing the operation", () => {
        let observer:
            | { next: (i: unknown) => void; error: (e: unknown) => void; complete: () => void }
            | undefined;
        let resolveStorage: (() => unknown) | undefined;
        const client = makeFakeClient({
            responses: {
                getHeadStorage: {
                    operation: { tag: "Started", value: { operationId: "op-storage" } },
                },
            },
            captureObserver: (value) => {
                observer = value;
            },
            deferMatch: (method, resolve) => {
                if (method !== "getHeadStorage") return false;
                resolveStorage = resolve;
                return true;
            },
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((message) => messages.push(message));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [false] });
        messages.length = 0;

        conn.send({
            jsonrpc: "2.0",
            id: 3,
            method: "chainHead_v1_storage",
            params: ["p:41", "0xhash", [{ key: "0x01", type: "value" }], null],
        });
        observer?.next({
            tag: "OperationStorageItems",
            value: {
                operationId: "op-storage",
                items: [{ key: "0x01", value: "0xabcd" }],
            },
        });
        observer?.next({
            tag: "OperationStorageDone",
            value: { operationId: "op-storage" },
        });
        expect(messages).toEqual([]);

        resolveStorage?.();
        expect(
            messages.map((message) => ("id" in message ? message.id : message.params.result.event)),
        ).toEqual([3, "operationStorageItems", "operationStorageDone"]);
    });

    test("forwards an operation event that arrives after the operation ended", () => {
        let observer:
            | { next: (i: unknown) => void; error: (e: unknown) => void; complete: () => void }
            | undefined;
        const client = makeFakeClient({
            responses: {
                callHead: { operation: { tag: "Started", value: { operationId: "op-late" } } },
            },
            captureObserver: (value) => {
                observer = value;
            },
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((message) => messages.push(message));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [false] });
        conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_call",
            params: ["p:41", "0xhash", "Test_call", "0x"],
        });
        observer?.next({
            tag: "OperationCallDone",
            value: { operationId: "op-late", output: "0x1" },
        });
        messages.length = 0;

        observer?.next({
            tag: "OperationStorageItems",
            value: { operationId: "op-late", items: [{ key: "0x01", value: "0xabcd" }] },
        });

        expect(messages).toEqual([
            {
                jsonrpc: "2.0",
                method: "chainHead_v1_followEvent",
                params: {
                    subscription: "p:41",
                    result: {
                        event: "operationStorageItems",
                        operationId: "op-late",
                        items: [{ key: "0x01", value: "0xabcd" }],
                    },
                },
            },
        ]);
    });

    test("a failed operation start releases the follow's buffering", () => {
        let observer:
            | { next: (i: unknown) => void; error: (e: unknown) => void; complete: () => void }
            | undefined;
        const client = makeFakeClient({
            errors: { callHead: { reason: "host unavailable" } },
            captureObserver: (value) => {
                observer = value;
            },
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((message) => messages.push(message));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [false] });
        conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_call",
            params: ["p:41", "0xhash", "Test_call", "0x"],
        });
        messages.length = 0;

        // A failed start never sends `Started`. If it left the count raised, every
        // later event for an unknown operation would buffer for the life of the follow.
        observer?.next({
            tag: "OperationStorageItems",
            value: { operationId: "op-unknown", items: [{ key: "0x01", value: "0xabcd" }] },
        });

        expect(messages).toEqual([
            {
                jsonrpc: "2.0",
                method: "chainHead_v1_followEvent",
                params: {
                    subscription: "p:41",
                    result: {
                        event: "operationStorageItems",
                        operationId: "op-unknown",
                        items: [{ key: "0x01", value: "0xabcd" }],
                    },
                },
            },
        ]);
    });

    test("chainSpec_v1_properties parses the JSON-encoded properties string", () => {
        const client = makeFakeClient({});
        const provider = createHostPapiProvider(client, "0xfeed");
        const messages: JsonRpcMessage[] = [];
        provider((m) => messages.push(m)).send({
            jsonrpc: "2.0",
            id: 7,
            method: "chainSpec_v1_properties",
            params: [],
        });
        expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 7, result: { ss58Format: 0 } });
    });

    test("chainHead_v1_body unwraps the operation into a JSON-RPC start result", () => {
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ onCall: (m, a) => calls.push([m, a]) });
        const provider = createHostPapiProvider(client, "0xfeed");
        const messages: JsonRpcMessage[] = [];
        provider((m) => messages.push(m)).send({
            jsonrpc: "2.0",
            id: 3,
            method: "chainHead_v1_body",
            params: ["follow_0", "0xhash"],
        });
        expect(calls[0]).toEqual([
            "getHeadBody",
            { genesisHash: "0xfeed", followSubscriptionId: "follow_0", hash: "0xhash" },
        ]);
        expect(messages[0]).toEqual({
            jsonrpc: "2.0",
            id: 3,
            result: { result: "started", operationId: "op1" },
        });
    });

    test("unknown methods produce a method-not-found error", () => {
        const client = makeFakeClient({});
        const provider = createHostPapiProvider(client, "0xfeed");
        const messages: JsonRpcMessage[] = [];
        provider((m) => messages.push(m)).send({
            jsonrpc: "2.0",
            id: 9,
            method: "system_health",
            params: [],
        });
        expect(messages[0]).toMatchObject({ id: 9, error: { code: -32601 } });
    });

    test("a transport interrupt synthesizes a stop follow-event", () => {
        let observer:
            | { next: (i: unknown) => void; error: (e: unknown) => void; complete: () => void }
            | undefined;
        const client = makeFakeClient({
            captureObserver: (o) => {
                observer = o;
            },
        });
        const provider = createHostPapiProvider(client, "0xfeed");
        const messages: JsonRpcMessage[] = [];
        const conn = provider((m) => messages.push(m));

        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        // The stream ends via transport close (no Stop item) — the consumer must
        // still see a stop so its substrate-client refollows.
        observer?.complete();
        expect(messages[1]).toEqual({
            jsonrpc: "2.0",
            method: "chainHead_v1_followEvent",
            params: { subscription: "p:41", result: { event: "stop" } },
        });
    });

    test("a host error becomes a JSON-RPC -32603 with the formatted reason", () => {
        const client = makeFakeClient({ errors: { getHeadHeader: { reason: "no such block" } } });
        const provider = createHostPapiProvider(client, "0xfeed");
        const messages: JsonRpcMessage[] = [];
        provider((m) => messages.push(m)).send({
            jsonrpc: "2.0",
            id: 4,
            method: "chainHead_v1_header",
            params: ["follow_0", "0xhash"],
        });
        expect(messages[0]).toEqual({
            jsonrpc: "2.0",
            id: 4,
            error: { code: -32603, message: "no such block" },
        });
    });

    test("disconnect unsubscribes active follows and stops active broadcasts", () => {
        const unsubscribe = vi.fn();
        const calls: Array<[string, unknown]> = [];
        const client = makeFakeClient({ unsubscribe, onCall: (m, a) => calls.push([m, a]) });
        const provider = createHostPapiProvider(client, "0xfeed");
        const conn = provider(() => {});

        // Open a follow and an in-flight broadcast (operationId "bc1" is tracked).
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        conn.send({ jsonrpc: "2.0", id: 2, method: "transaction_v1_broadcast", params: ["0xtx"] });

        conn.disconnect();

        // The follow subscription is torn down...
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        // ...and the tracked broadcast is stopped on the way out.
        expect(calls).toContainEqual([
            "stopTransaction",
            { genesisHash: "0xfeed", operationId: "bc1" },
        ]);
    });
}
