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
 * - A `chainHead` read on a follow that has ended stays unanswered until that
 *   stop is out, so polkadot-api sends it again on its new follow instead of
 *   failing its caller. See {@link endsFollow}.
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
import {
    isConnectionReset,
    isProductionBuild,
    subscribeWithInterrupt,
    type TransportSubscription,
} from "./transport.js";
import { matchHostResult } from "./truapi.js";

const log = createLogger("host:papi");

/** JSON-RPC internal-error code used for every host-side failure (matches the upstream). */
const JSON_RPC_INTERNAL_ERROR = -32603;
/** JSON-RPC method-not-found code for chainHead methods the host doesn't serve. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * The first wait of both backoffs: before a synthetic stop, doubled on each one
 * in a row, and between a follow and the one replacing it.
 */
const SHORTEST_STOP_DELAY_MS = 250;
/** The longest wait of both backoffs, unless follows keep being refused. */
const LONGEST_STOP_DELAY_MS = 4000;
/**
 * The longest wait before a synthetic stop once follows keep ending before any
 * event, which is how a node refusing follows (`-32800`) reaches a product: the
 * truapi core ends each refused stream with a plain interrupt and the code never
 * arrives (#543). A chain socket the core is redialling looks the same, so the
 * wait only grows past {@link LONGEST_STOP_DELAY_MS} after
 * {@link REFUSALS_BEFORE_LONG_BACKOFF} in a row.
 */
const LONGEST_REFUSED_STOP_DELAY_MS = 30_000;
/** Follows in a row that end before any event before the stop wait passes 4 s: about 20 s of them. */
const REFUSALS_BEFORE_LONG_BACKOFF = 8;
/**
 * How long a follow stays up after `Initialized` before it shows the host is
 * steady, when no read on it has succeeded. `Initialized` alone does not: a host
 * can end every follow just after it initializes.
 */
const STEADY_FOLLOW_MS = 10_000;
/** The least time between two warn summaries of a connection whose follows keep failing. */
const FOLLOW_LOOP_SUMMARY_MS = 60_000;
/** How long a follow lasts before the one replacing it starts a new incident. */
const REPLACE_RESET_MS = 60_000;

/** A `chainHead_v1_followEvent` payload (loosely typed — consumed by PAPI's substrate-client). */
type FollowEvent = { event: string } & Record<string, unknown>;

type BufferedOperation = {
    announced: boolean;
    items: RemoteChainHeadFollowItem[];
};

/**
 * How a host says it no longer has a follow.
 *
 * Older hosts send the first wording and newer ones name why the follow ended, with
 * the same error kind in both, so only the text can tell them apart from any other
 * failure of a read.
 */
const FOLLOW_LOST =
    /unknown follow subscription id|follow subscription "[^"]*" (?:ended|was stopped)/;

/** Whether a read failed because the follow it named has ended, not because of the read. */
function endsFollow(error: unknown): boolean {
    return isConnectionReset(error) || FOLLOW_LOST.test(formatHostError(error));
}

/**
 * The provider connections of this product that hold an active follow, per chain.
 *
 * The host allows a product few `chainHead_v1_follow`s per chain and polkadot-api
 * holds one per client, so a second connection following a chain is a second
 * client on it, which `createChainClient` / `getClient` would have shared. A
 * product's iframe or Worker has its own module instance, so this counts one
 * product. Keyed by connection, not by follow: a client that follows again
 * during stop recovery is still one client while its follows overlap.
 */
const followersByChain = new Map<HexString, Set<object>>();

/**
 * Record whether `connection` holds a follow on `genesisHash`, and report the
 * chain's follows outside production whenever a connection joins a chain
 * another connection already follows.
 */
function noteFollower(genesisHash: HexString, connection: object, following: boolean): void {
    const followers = followersByChain.get(genesisHash);
    if (!following) {
        if (followers?.delete(connection) && followers.size === 0) {
            followersByChain.delete(genesisHash);
        }
        return;
    }
    if (followers?.has(connection)) return;
    const joined = followers ?? new Set<object>();
    joined.add(connection);
    followersByChain.set(genesisHash, joined);
    if (joined.size > 1 && !isProductionBuild()) {
        log.error(
            `chain ${genesisHash} now has ${joined.size} follows from this product: share one client per chain (createChainClient / getClient) instead of creating another.`,
        );
    }
}

/** Forget every follower. For tests, which reuse a chain across providers. */
export function resetFollowersForTests(): void {
    followersByChain.clear();
}

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
        let disconnected = false;
        // A stop this provider makes up is paced, because PAPI follows again at
        // once, and so is a Stop from the host on a follow that is not steady yet.
        // A Stop on a steady follow is forwarded at once.
        let transportRetryDelay = SHORTEST_STOP_DELAY_MS;
        /** Follows in a row that ended before any event, not by a lost host link. */
        let refusedInARow = 0;
        /**
         * Whether a read was answered with a lost follow since a read last succeeded.
         *
         * A follow that reached `Initialized` and then lost a read does not show that
         * the host is stable, so a follow's age does not count as steady while this
         * is set, and only a read that succeeds brings the delay back.
         */
        let lostReadSinceSuccess = false;
        const interruptedFollows = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
        /**
         * A run of follows that went wrong the same way, logged so that a phone
         * stuck in a loop does not fill its log with lines for every attempt (#543).
         *
         * Two runs, kept apart because they end differently: follows that ended
         * before the host proved steady, which a steady follow ends, and follows
         * their client abandoned, which only a clean unfollow ends. A client that
         * keeps abandoning follows is broken while the host is fine, so its new
         * follows initialize and would otherwise end the run each time.
         */
        type Run = {
            count: number;
            since: number;
            summarizedAt: number;
            summary: (count: number, seconds: number, backoff: number) => string;
        };
        const endedRun: Run = {
            count: 0,
            since: 0,
            summarizedAt: 0,
            summary: (count, seconds, backoff) =>
                `chainHead follows on this connection keep failing: ${count} ended in ${seconds} s, the stop backoff is now ${backoff} ms`,
        };
        const releasedRun: Run = {
            count: 0,
            since: 0,
            summarizedAt: 0,
            summary: (count, seconds, backoff) =>
                `chainHead follows on this connection keep being abandoned by their client: ${count} released in ${seconds} s, the replacement backoff is now ${backoff} ms`,
        };
        /**
         * Count one more follow in `run`, and say how loud to log it: the first of a
         * run is a warn line and the rest are debug, with a warn summary, carrying
         * the backoff, at most once a {@link FOLLOW_LOOP_SUMMARY_MS}.
         */
        function noteRun(run: Run, backoff: number): "warn" | "debug" {
            const now = Date.now();
            run.count += 1;
            if (run.count === 1) {
                run.since = now;
                run.summarizedAt = now;
                return "warn";
            }
            if (now - run.summarizedAt >= FOLLOW_LOOP_SUMMARY_MS) {
                run.summarizedAt = now;
                log.warn(run.summary(run.count, Math.round((now - run.since) / 1000), backoff));
            }
            return "debug";
        }
        /** The host is steady again: refollows start at the shortest delay. */
        function steady(followSubscriptionId: string): void {
            transportRetryDelay = SHORTEST_STOP_DELAY_MS;
            if (endedRun.count > 1) {
                log.warn(
                    `chainHead follow ${followSubscriptionId} is steady after ${endedRun.count} ended follows in ${Math.round((Date.now() - endedRun.since) / 1000)} s`,
                );
            }
            endedRun.count = 0;
        }
        function readSucceeded(followSubscriptionId: string): void {
            if (
                !activeFollows.has(followSubscriptionId) ||
                interruptedFollows.has(followSubscriptionId)
            )
                return;
            lostReadSinceSuccess = false;
            const age = followAges.get(followSubscriptionId);
            if (age !== undefined) age.readSucceeded = true;
            steady(followSubscriptionId);
        }
        /**
         * Whether a follow has shown the host is steady: a read on it succeeded, or
         * it stayed up {@link STEADY_FOLLOW_MS} after `Initialized` with no read lost
         * since one last succeeded.
         */
        function isSteady(followSubscriptionId: string): boolean {
            const age = followAges.get(followSubscriptionId);
            if (age === undefined) return false;
            if (age.readSucceeded) return true;
            return (
                age.initializedAt !== undefined &&
                !lostReadSinceSuccess &&
                Date.now() - age.initializedAt >= STEADY_FOLLOW_MS
            );
        }
        /** Unsubscribe a follow's host stream, logging rather than throwing if that fails. */
        function unsubscribeQuietly(
            followSubscriptionId: string,
            follow: TransportSubscription,
            when: string,
        ): void {
            try {
                follow.unsubscribe();
            } catch (thrown) {
                log.warn(`chainHead follow ${followSubscriptionId}: unsubscribe failed ${when}`, {
                    error: formatHostError(thrown),
                });
            }
        }
        /**
         * Follows this connection released because their client followed again
         * without unfollowing them, kept for the connection's life: their
         * followers never stop, so a late answer can come at any time, and it is
         * dropped (see {@link releaseFollow}).
         */
        const releasedFollows = new Set<string>();
        /** The `chainHead_v1_follow` request held back by `replaceDelay`, opened when its timer fires. */
        let waitingFollow:
            | {
                  id: JsonRpcRequest["id"];
                  withRuntime: boolean;
                  timer?: ReturnType<typeof setTimeout>;
              }
            | undefined;
        /** When this connection last opened a host follow. */
        let lastFollowAt = 0;
        /**
         * The least time between a follow and the one that replaces it, doubled on
         * each replacement up to {@link LONGEST_STOP_DELAY_MS}.
         *
         * Apart from {@link transportRetryDelay}, because a client that keeps
         * abandoning follows is broken while the host is fine: its new follows
         * initialize and their reads succeed, which would keep resetting that one.
         * Back to the shortest once the client unfollows, or once a follow lasts
         * {@link REPLACE_RESET_MS} before it is replaced.
         */
        let replaceDelay = SHORTEST_STOP_DELAY_MS;
        /** The client is not abandoning follows: replacements start over. */
        function resetReplace(): void {
            replaceDelay = SHORTEST_STOP_DELAY_MS;
            releasedRun.count = 0;
        }
        function cancelTransportStop(subscription: string): void {
            const pending = interruptedFollows.get(subscription);
            interruptedFollows.delete(subscription);
            if (pending?.timer !== undefined) clearTimeout(pending.timer);
        }
        /** Tell the chain's follower set whether this connection still follows. */
        function syncFollower(): void {
            noteFollower(genesisHash, connection, activeFollows.size > 0);
        }
        const heldReads = new Map<string, JsonRpcRequest["id"][]>();
        const followAges = new Map<
            string,
            {
                startedAt: number;
                events: number;
                lastEventAt: number;
                initializedAt?: number;
                readSucceeded: boolean;
            }
        >();
        let stoppedAt: number | null = null;

        function followState(subscription: string): string {
            const age = followAges.get(subscription);
            if (!age) return "unknown to this provider";
            const now = Date.now();
            const events =
                age.events === 0
                    ? "no events"
                    : `${age.events} ${age.events === 1 ? "event" : "events"}, the last ${now - age.lastEventAt} ms ago`;
            const inFlight =
                (followOperations.get(subscription)?.size ?? 0) +
                (pendingOperationStarts.get(subscription) ?? 0);
            return `up ${now - age.startedAt} ms, ${events}, ${inFlight} operations in flight`;
        }

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
            readSucceeded(followSubscriptionId);
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
                    readError(id, followSubscriptionId)(error);
                },
            };
        }

        /** Reject an inbound request with the host's error reason as the JSON-RPC message. */
        const hostError = (id: JsonRpcRequest["id"]) => (error: unknown) =>
            sendJsonRpcError(id, JSON_RPC_INTERNAL_ERROR, formatHostError(error));
        /** {@link hostError} for a request on a follow, unanswered once that follow was released. */
        const followError =
            (id: JsonRpcRequest["id"], followSubscriptionId: string) => (error: unknown) => {
                if (!releasedFollows.has(followSubscriptionId)) hostError(id)(error);
            };

        /**
         * Hold a read whose follow has ended until its stop is out.
         *
         * polkadot-api sends a read again only if it is still waiting when the stop
         * arrives, and fails the caller on any answer before that.
         */
        function holdRead(id: JsonRpcRequest["id"], followSubscriptionId: string): void {
            const held = heldReads.get(followSubscriptionId);
            if (held) held.push(id);
            else heldReads.set(followSubscriptionId, [id]);
        }

        function heldForStop(id: JsonRpcRequest["id"], followSubscriptionId: string): boolean {
            if (!interruptedFollows.has(followSubscriptionId)) return false;
            holdRead(id, followSubscriptionId);
            return true;
        }

        /**
         * Answer the held reads of a follow after its stop.
         *
         * polkadot-api has given up on them by then, but its raw client keeps a
         * request until it is answered, so leaving them unanswered would leak.
         */
        function releaseHeldReads(followSubscriptionId: string): void {
            const held = heldReads.get(followSubscriptionId);
            if (!held) return;
            heldReads.delete(followSubscriptionId);
            for (const id of held) {
                sendJsonRpcError(
                    id,
                    JSON_RPC_INTERNAL_ERROR,
                    `chainHead follow ${followSubscriptionId} ended`,
                );
            }
        }

        const readError =
            (id: JsonRpcRequest["id"], followSubscriptionId: string) => (error: unknown) => {
                // Unanswered: an abandoned follower's error can restart the live one.
                if (releasedFollows.has(followSubscriptionId)) return;
                if (heldForStop(id, followSubscriptionId)) return;
                const follow = activeFollows.get(followSubscriptionId);
                if (!follow || !endsFollow(error)) {
                    hostError(id)(error);
                    return;
                }
                holdRead(id, followSubscriptionId);
                // Set first, so the follow's age does not count as steady.
                lostReadSinceSuccess = true;
                // The frame ending this follow may never come, and only a stop ends the hold.
                interruptFollow(followSubscriptionId, follow, error);
                unsubscribeQuietly(followSubscriptionId, follow, "after a lost read");
            };

        function interruptFollow(
            followSubscriptionId: string,
            follow: TransportSubscription,
            reason?: unknown,
        ): void {
            if (
                disconnected ||
                activeFollows.get(followSubscriptionId) !== follow ||
                interruptedFollows.has(followSubscriptionId)
            )
                return;
            const state = followState(followSubscriptionId);
            const hostLinkLost = isConnectionReset(reason);
            // A follow that showed the host steady starts the backoff over.
            if (isSteady(followSubscriptionId)) steady(followSubscriptionId);
            // Ended before any event, and not by a lost host link: refused by the
            // node, or cut while the core redials the chain socket.
            if ((followAges.get(followSubscriptionId)?.events ?? 0) === 0 && !hostLinkLost)
                refusedInARow += 1;
            followOperations.delete(followSubscriptionId);
            pendingOperationStarts.delete(followSubscriptionId);
            const pending: { timer?: ReturnType<typeof setTimeout> } = {};
            interruptedFollows.set(followSubscriptionId, pending);
            // A lost host link comes back on its own, so its stop never waits for
            // a refusal run to end.
            const delay = hostLinkLost
                ? Math.min(transportRetryDelay, LONGEST_STOP_DELAY_MS)
                : transportRetryDelay;
            transportRetryDelay = Math.min(
                delay * 2,
                refusedInARow >= REFUSALS_BEFORE_LONG_BACKOFF && !hostLinkLost
                    ? LONGEST_REFUSED_STOP_DELAY_MS
                    : LONGEST_STOP_DELAY_MS,
            );
            const cause = reason === undefined ? "ended by the host" : formatHostError(reason);
            log[noteRun(endedRun, transportRetryDelay)](
                `chainHead follow ${followSubscriptionId} interrupted (${cause}): ${state}, stop in ${delay} ms`,
            );
            pending.timer = setTimeout(() => {
                // clearTimeout cannot recall a callback already queued.
                if (
                    disconnected ||
                    interruptedFollows.get(followSubscriptionId) !== pending ||
                    activeFollows.get(followSubscriptionId) !== follow
                )
                    return;
                interruptedFollows.delete(followSubscriptionId);
                activeFollows.delete(followSubscriptionId);
                stoppedAt = Date.now();
                followAges.delete(followSubscriptionId);
                sendFollowEvent(followSubscriptionId, { event: "stop" });
                releaseHeldReads(followSubscriptionId);
                // After the stop is delivered, so a client that follows again at
                // once is still the one client this connection is on the chain.
                syncFollower();
            }, delay);
        }

        /**
         * Let go of a follow its client abandoned by following again without
         * unfollowing it.
         *
         * A polkadot-api client holds one follow, and ends or unfollows it before
         * following again, so another follow on this connection means the client
         * dropped the one it had. It does exactly that once its pinned blocks
         * break (observable-client 0.19), and keeps the abandoned follower's
         * callbacks alive (#543). So nothing more is sent for this follow. A stop
         * would make that follower follow again, and since polkadot-api shares one
         * follower pointer across its subscriptions, take the live follower's
         * place. An error to its follow request makes it retry, and an error to its
         * other requests can reach the `reset` polkadot-api shares with the live
         * follower. Its held reads and late answers stay unanswered.
         *
         * The cost: the requests this follow had in flight stay in the client's raw
         * client until it cancels them or is destroyed, and the id stays here.
         * polkadot-api already keeps each abandoned follower itself, and rebuilding
         * the client frees all of it. A raw substrate-client that holds two
         * follows on one connection is not supported.
         */
        function releaseFollow(
            followSubscriptionId: string,
            follow: TransportSubscription,
            nextDelay: number,
        ): void {
            const state = followState(followSubscriptionId);
            cancelTransportStop(followSubscriptionId);
            activeFollows.delete(followSubscriptionId);
            followAges.delete(followSubscriptionId);
            followOperations.delete(followSubscriptionId);
            pendingOperationStarts.delete(followSubscriptionId);
            heldReads.delete(followSubscriptionId);
            releasedFollows.add(followSubscriptionId);
            log[noteRun(releasedRun, nextDelay)](
                `chainHead follow ${followSubscriptionId} released, its client followed again without unfollowing it: ${state}`,
            );
            unsubscribeQuietly(followSubscriptionId, follow, "on release");
        }

        /** Open a follow request that abandoned follows made wait, once `wait` ms have passed. */
        function scheduleFollow(
            id: JsonRpcRequest["id"],
            withRuntime: boolean,
            wait: number,
        ): void {
            const waiting: NonNullable<typeof waitingFollow> = { id, withRuntime };
            waitingFollow = waiting;
            waiting.timer = setTimeout(() => {
                // clearTimeout cannot recall a callback already queued.
                if (disconnected || waitingFollow !== waiting) return;
                waitingFollow = undefined;
                try {
                    openFollow(waiting.id, waiting.withRuntime);
                } catch (error) {
                    log.warn("chainHead_v1_follow: opening a waiting follow threw", {
                        error: formatHostError(error),
                    });
                    sendJsonRpcError(waiting.id, JSON_RPC_INTERNAL_ERROR, formatHostError(error));
                }
            }, wait);
        }

        /** Open a host follow for the `chainHead_v1_follow` request `id`. */
        function openFollow(id: JsonRpcRequest["id"], withRuntime: boolean): void {
            // The Stop branch unsubscribes its own host subscription, but the
            // handle is this call's return value — the ref breaks that
            // chicken-and-egg. (Releasing before forwarding the Stop is just
            // cleanup; the consumer's synchronous refollow gets a fresh wire
            // subscription either way.)
            const ref: { handle?: TransportSubscription } = {};
            const pendingItems: RemoteChainHeadFollowItem[] = [];
            const forwardItem = (followSubscriptionId: string, item: RemoteChainHeadFollowItem) => {
                if (
                    disconnected ||
                    activeFollows.get(followSubscriptionId) !== ref.handle ||
                    interruptedFollows.has(followSubscriptionId)
                )
                    return;
                const age = followAges.get(followSubscriptionId);
                if (age !== undefined && item.tag !== "Stop") {
                    if (item.tag === "Initialized") age.initializedAt ??= Date.now();
                    if (age.events === 0) {
                        // The node took this follow, so it is not refusing them.
                        transportRetryDelay = Math.min(transportRetryDelay, LONGEST_STOP_DELAY_MS);
                        refusedInARow = 0;
                    }
                    age.events += 1;
                    age.lastEventAt = Date.now();
                }
                if (item.tag === "Stop" && !isSteady(followSubscriptionId)) {
                    // polkadot-api follows again as soon as it sees a stop, inside the
                    // call that delivered it, so a host that ends follows before they
                    // are steady would loop as fast as it answers. Paced like an
                    // interrupt instead (#543).
                    // The guard above matched `ref.handle`, so it is set.
                    const follow = ref.handle as TransportSubscription;
                    interruptFollow(
                        followSubscriptionId,
                        follow,
                        new Error("stopped by the host before it was steady"),
                    );
                    unsubscribeQuietly(followSubscriptionId, follow, "after a stop");
                    return;
                }
                const stopped = item.tag === "Stop" && activeFollows.delete(followSubscriptionId);
                if (stopped) {
                    steady(followSubscriptionId);
                    log[noteRun(endedRun, transportRetryDelay)](
                        `chainHead follow ${followSubscriptionId} stopped by the host: ${followState(followSubscriptionId)}`,
                    );
                    stoppedAt = Date.now();
                    followAges.delete(followSubscriptionId);
                    cancelTransportStop(followSubscriptionId);
                    ref.handle?.unsubscribe();
                    followOperations.delete(followSubscriptionId);
                    pendingOperationStarts.delete(followSubscriptionId);
                }
                forwardFollowItem(followSubscriptionId, item);
                // After the stop is delivered, so a client that follows again at
                // once is still the one client this connection is on the chain.
                if (stopped) syncFollower();
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
                // A follow this one replaced may have kept the connection on the chain.
                syncFollower();
                sendJsonRpcError(
                    id,
                    JSON_RPC_INTERNAL_ERROR,
                    "Host follow subscription did not start",
                );
                return;
            }
            // Registered before `onInterrupt`, because an interrupt that
            // landed while the stream was starting is replayed into it:
            // the guards below read this follow back, so a follow still
            // waiting to be recorded would read as a superseded one and
            // the stop that makes the consumer refollow would be lost.
            activeFollows.set(followSubscriptionId, ref.handle);
            syncFollower();
            followOperations.set(followSubscriptionId, new Map());
            pendingOperationStarts.set(followSubscriptionId, 0);
            const startedAt = Date.now();
            lastFollowAt = startedAt;
            followAges.set(followSubscriptionId, {
                startedAt,
                events: 0,
                lastEventAt: startedAt,
                readSucceeded: false,
            });
            if (stoppedAt === null) {
                log.info(`chainHead follow ${followSubscriptionId} started`);
            } else {
                log[endedRun.count > 1 ? "debug" : "warn"](
                    `chainHead follow ${followSubscriptionId} restarted ${startedAt - stoppedAt} ms after the stop`,
                );
            }
            stoppedAt = null;
            // A transport interrupt/close ends the stream without a Stop
            // item; synthesize one so the consumer refollows.
            const follow = ref.handle;
            follow.onInterrupt((reason) => interruptFollow(followSubscriptionId, follow, reason));
            sendJsonRpcResponse(id, followSubscriptionId);
            for (const item of pendingItems) {
                forwardItem(followSubscriptionId, item);
            }
        }

        function handleMessage(message: JsonRpcRequest): void {
            const { id, method } = message;
            // chainHead/chainSpec/transaction JSON-RPC params are positional arrays.
            const params = (message.params ?? []) as unknown[];

            switch (method) {
                case "chainHead_v1_follow": {
                    const [withRuntime] = params as [boolean];
                    // Any follow this connection still holds was abandoned (see
                    // `releaseFollow`). The new one waits out `replaceDelay` from the
                    // last follow's start, so a client that keeps abandoning follows
                    // cannot open one per read.
                    let wait = 0;
                    if (activeFollows.size > 0) {
                        // A follow that lasted makes this a new incident.
                        if (Date.now() - lastFollowAt >= REPLACE_RESET_MS) resetReplace();
                        wait = lastFollowAt + replaceDelay - Date.now();
                        replaceDelay = Math.min(replaceDelay * 2, LONGEST_STOP_DELAY_MS);
                        for (const [subscription, follow] of [...activeFollows])
                            releaseFollow(subscription, follow, replaceDelay);
                    }
                    if (waitingFollow) {
                        // The request still waiting was abandoned before it opened.
                        // This one takes its turn, and that one is never answered.
                        waitingFollow.id = id;
                        waitingFollow.withRuntime = withRuntime;
                        break;
                    }
                    if (wait > 0) scheduleFollow(id, withRuntime, wait);
                    else openFollow(id, withRuntime);
                    break;
                }
                case "chainHead_v1_unfollow": {
                    const [followSubId] = params as [string];
                    const follow = activeFollows.get(followSubId);
                    if (follow) {
                        log.warn(
                            `chainHead follow ${followSubId} unfollowed: ${followState(followSubId)}`,
                        );
                    }
                    followAges.delete(followSubId);
                    cancelTransportStop(followSubId);
                    // The client ended its follow itself, so it is not abandoning them.
                    if (activeFollows.delete(followSubId)) resetReplace();
                    syncFollower();
                    if (follow) unsubscribeQuietly(followSubId, follow, "on unfollow");
                    followOperations.delete(followSubId);
                    pendingOperationStarts.delete(followSubId);
                    sendJsonRpcResponse(id, null);
                    releaseHeldReads(followSubId);
                    break;
                }
                case "chainHead_v1_header": {
                    const [followSubscriptionId, hash] = params as [string, HexString];
                    if (heldForStop(id, followSubscriptionId)) break;
                    matchHostResult(
                        chain.getHeadHeader({ genesisHash, followSubscriptionId, hash }),
                        method,
                        (response) => {
                            readSucceeded(followSubscriptionId);
                            sendJsonRpcResponse(id, response.header ?? null);
                        },
                        readError(id, followSubscriptionId),
                    );
                    break;
                }
                case "chainHead_v1_body": {
                    const [followSubscriptionId, hash] = params as [string, HexString];
                    if (heldForStop(id, followSubscriptionId)) break;
                    const bodyStart = startOperationRequest(id, followSubscriptionId);
                    matchHostResult(
                        chain.getHeadBody({ genesisHash, followSubscriptionId, hash }),
                        method,
                        bodyStart.ok,
                        bodyStart.err,
                    );
                    break;
                }
                case "chainHead_v1_storage": {
                    const [followSubscriptionId, hash, items, childTrie] = params as [
                        string,
                        HexString,
                        Array<{ key: HexString; type: string }>,
                        HexString | undefined,
                    ];
                    if (heldForStop(id, followSubscriptionId)) break;
                    const queryItems = items.map((item) => ({
                        key: item.key,
                        queryType: convertStorageType(item.type),
                    }));
                    const storageStart = startOperationRequest(id, followSubscriptionId);
                    matchHostResult(
                        chain.getHeadStorage({
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
                        }),
                        method,
                        storageStart.ok,
                        storageStart.err,
                    );
                    break;
                }
                case "chainHead_v1_call": {
                    const [followSubscriptionId, hash, fn, callParameters] = params as [
                        string,
                        HexString,
                        string,
                        HexString,
                    ];
                    if (heldForStop(id, followSubscriptionId)) break;
                    const callStart = startOperationRequest(id, followSubscriptionId);
                    matchHostResult(
                        chain.callHead({
                            genesisHash,
                            followSubscriptionId,
                            hash,
                            function: fn,
                            callParameters,
                        }),
                        method,
                        callStart.ok,
                        callStart.err,
                    );
                    break;
                }
                case "chainHead_v1_unpin": {
                    const [followSubscriptionId, hashOrHashes] = params as [
                        string,
                        HexString | HexString[],
                    ];
                    const hashes = Array.isArray(hashOrHashes) ? hashOrHashes : [hashOrHashes];
                    matchHostResult(
                        chain.unpinHead({ genesisHash, followSubscriptionId, hashes }),
                        method,
                        () => sendJsonRpcResponse(id, null),
                        followError(id, followSubscriptionId),
                    );
                    break;
                }
                case "chainHead_v1_continue": {
                    const [followSubscriptionId, operationId] = params as [string, string];
                    matchHostResult(
                        chain.continueHead({ genesisHash, followSubscriptionId, operationId }),
                        method,
                        () => sendJsonRpcResponse(id, null),
                        followError(id, followSubscriptionId),
                    );
                    break;
                }
                case "chainHead_v1_stopOperation": {
                    const [followSubscriptionId, operationId] = params as [string, string];
                    matchHostResult(
                        chain.stopHeadOperation({ genesisHash, followSubscriptionId, operationId }),
                        method,
                        () => {
                            followOperations.get(followSubscriptionId)?.delete(operationId);
                            sendJsonRpcResponse(id, null);
                        },
                        followError(id, followSubscriptionId),
                    );
                    break;
                }
                case "chainSpec_v1_genesisHash": {
                    matchHostResult(
                        chain.getSpecGenesisHash({ genesisHash }),
                        method,
                        (response) => sendJsonRpcResponse(id, response.genesisHash),
                        hostError(id),
                    );
                    break;
                }
                case "chainSpec_v1_chainName": {
                    matchHostResult(
                        chain.getSpecChainName({ genesisHash }),
                        method,
                        (response) => sendJsonRpcResponse(id, response.chainName),
                        hostError(id),
                    );
                    break;
                }
                case "chainSpec_v1_properties": {
                    matchHostResult(
                        chain.getSpecProperties({ genesisHash }),
                        method,
                        (response) => {
                            try {
                                sendJsonRpcResponse(id, JSON.parse(response.properties));
                            } catch {
                                sendJsonRpcResponse(id, response.properties);
                            }
                        },
                        hostError(id),
                    );
                    break;
                }
                case "transaction_v1_broadcast": {
                    const [transaction] = params as [HexString];
                    matchHostResult(
                        chain.broadcastTransaction({ genesisHash, transaction }),
                        method,
                        (response) => {
                            const operationId = response.operationId ?? null;
                            if (operationId !== null) activeBroadcasts.add(operationId);
                            sendJsonRpcResponse(id, operationId);
                        },
                        hostError(id),
                    );
                    break;
                }
                case "transaction_v1_stop": {
                    const [operationId] = params as [string];
                    activeBroadcasts.delete(operationId);
                    matchHostResult(
                        chain.stopTransaction({ genesisHash, operationId }),
                        method,
                        () => sendJsonRpcResponse(id, null),
                        hostError(id),
                    );
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

        const connection: JsonRpcConnection = {
            send(message) {
                if (disconnected) return;
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
                disconnected = true;
                for (const subscription of interruptedFollows.keys())
                    cancelTransportStop(subscription);
                if (waitingFollow) clearTimeout(waitingFollow.timer);
                waitingFollow = undefined;
                releasedFollows.clear();
                const handles = [...activeFollows.values()];
                activeFollows.clear();
                syncFollower();
                for (const handle of handles) handle.unsubscribe();
                followOperations.clear();
                pendingOperationStarts.clear();
                followAges.clear();
                heldReads.clear();
                for (const operationId of activeBroadcasts) {
                    // Fire-and-forget: the transport may already be torn down.
                    matchHostResult(
                        chain.stopTransaction({ genesisHash, operationId }),
                        "transaction_v1_stop",
                        () => {},
                        () => {},
                    );
                }
                activeBroadcasts.clear();
            },
        };
        return connection;
    };
}

if (import.meta.vitest) {
    const { test, expect, vi, afterEach, beforeEach } = import.meta.vitest;
    const { configure } = await import("@parity/product-sdk-logger");

    afterEach(() => {
        vi.useRealTimers();
    });

    const lines: string[] = [];
    configure({
        level: "warn",
        handler: (entry) => lines.push(`${entry.level}: ${entry.message}`),
    });
    beforeEach(() => {
        lines.length = 0;
        resetFollowersForTests();
    });

    type FollowObserver = {
        next: (i: unknown) => void;
        error: (e: unknown) => void;
        complete: () => void;
    };

    // A minimal fake of the truapi chain domain. ResultAsync is approximated by a
    // `.match(ok, err)` thenable; the follow subscription is a hand-driven
    // ObservableLike whose observer we capture to push items at will.
    function makeFakeClient(opts: {
        onCall?: (method: string, args: unknown) => void;
        responses?: Record<string, unknown>;
        /** Methods named here resolve to their `.match` error arm carrying the given value. */
        errors?: Record<string, unknown>;
        /** Methods named here reject, the way truapi rejects a call that timed out. */
        rejections?: Record<string, unknown>;
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
        /** Transport request id assigned to the follow subscription (a function: one per follow). */
        subscriptionId?: string | (() => string);
    }) {
        const errMatch = (error: unknown) => ({
            match: (_ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => err(error),
        });
        const method = (name: string, response: unknown) => (args: unknown) => {
            opts.onCall?.(name, args);
            const errors = opts.errors ?? {};
            if (name in errors) return errMatch(errors[name]);
            const rejections = opts.rejections ?? {};
            if (name in rejections) return { match: () => Promise.reject(rejections[name]) };
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
                            subscriptionId:
                                typeof opts.subscriptionId === "function"
                                    ? opts.subscriptionId()
                                    : (opts.subscriptionId ?? "p:41"),
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

    test("a transport interrupt synthesizes a stop follow-event after a delay", () => {
        vi.useFakeTimers();
        let observer: FollowObserver | undefined;
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
        // still see a stop so its substrate-client refollows, but not synchronously:
        // the refollow is immediate, so an unpaced stop retries in a tight loop.
        observer?.complete();
        expect(messages).toHaveLength(1);
        vi.advanceTimersByTime(250);
        expect(messages[1]).toEqual({
            jsonrpc: "2.0",
            method: "chainHead_v1_followEvent",
            params: { subscription: "p:41", result: { event: "stop" } },
        });
    });

    test("a follow whose transport is already gone still synthesizes a stop", () => {
        vi.useFakeTimers();
        // The host connection dies while the follow is being set up, so the
        // stream ends inside `subscribe`, before this follow can register for
        // the interrupt. Losing it would leave PAPI holding a dead follow id
        // and never refollowing, so every later read fails for good.
        const client = makeFakeClient({
            captureObserver: (o) => o.complete(),
        });
        const provider = createHostPapiProvider(client, "0xfeed");
        const messages: JsonRpcMessage[] = [];
        const conn = provider((m) => messages.push(m));

        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });

        expect(messages[0]).toEqual({ jsonrpc: "2.0", id: 1, result: "p:41" });
        vi.advanceTimersByTime(250);
        expect(messages[1]).toEqual({
            jsonrpc: "2.0",
            method: "chainHead_v1_followEvent",
            params: { subscription: "p:41", result: { event: "stop" } },
        });
    });

    /** Answer a header read on `subscription`, which marks the follow steady. */
    function readOn(conn: JsonRpcConnection, subscription: string, id = 900): void {
        conn.send({
            jsonrpc: "2.0",
            id,
            method: "chainHead_v1_header",
            params: [subscription, "0x01"],
        });
    }

    /** Follows that each get their own subscription id and captured observer. */
    function interruptibleFollows(extra: Parameters<typeof makeFakeClient>[0] = {}) {
        const observers: FollowObserver[] = [];
        let count = 0;
        const unsubscribe = vi.fn();
        const client = makeFakeClient({
            ...extra,
            subscriptionId: () => `p:${++count}`,
            unsubscribe,
            captureObserver: (o) => observers.push(o),
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((m) => messages.push(m));
        let id = 0;
        const follow = () => {
            conn.send({ jsonrpc: "2.0", id: ++id, method: "chainHead_v1_follow", params: [true] });
            return { subscription: `p:${count}`, observer: observers[observers.length - 1]! };
        };
        const unfollow = (subscription: string) =>
            conn.send({
                jsonrpc: "2.0",
                id: ++id,
                method: "chainHead_v1_unfollow",
                params: [subscription],
            });
        const stops = () =>
            messages.filter(
                (m) =>
                    (m as { params?: { result?: { event?: string } } }).params?.result?.event ===
                    "stop",
            ).length;
        return { conn, follow, unfollow, stops, messages, observers, unsubscribe };
    }

    test("synthetic stops back off from 250 ms, doubling to a 4000 ms cap", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        let expected = 0;
        for (const delay of [250, 500, 1000, 2000, 4000, 4000]) {
            const { observer } = f.follow();
            // A follow the node took: one ended before any event backs off further.
            observer.next({ tag: "BestBlockChanged", value: { bestBlockHash: "0x01" } });
            observer.error(new Error("transport closed"));
            // A second interrupt of the same stream schedules nothing more.
            observer.complete();
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(delay - 1);
            expect(f.stops()).toBe(expected);
            vi.advanceTimersByTime(1);
            expect(f.stops()).toBe(++expected);
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    test("a read that succeeds resets the backoff; Initialized alone and other items do not", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        f.follow().observer.complete();
        vi.advanceTimersByTime(250);
        expect(f.stops()).toBe(1);

        const second = f.follow();
        second.observer.next({ tag: "BestBlockChanged", value: { bestBlockHash: "0x01" } });
        second.observer.complete();
        vi.advanceTimersByTime(499);
        expect(f.stops()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(f.stops()).toBe(2);

        // A follow that initializes and then drops does not show the host is steady.
        const third = f.follow();
        third.observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
        third.observer.complete();
        vi.advanceTimersByTime(999);
        expect(f.stops()).toBe(2);
        vi.advanceTimersByTime(1);
        expect(f.stops()).toBe(3);

        const fourth = f.follow();
        fourth.observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
        readOn(f.conn, fourth.subscription);
        fourth.observer.complete();
        vi.advanceTimersByTime(250);
        expect(f.stops()).toBe(4);
    });

    test("a genuine Stop item on a steady follow is forwarded at once and does not back off", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        const { observer, subscription } = f.follow();
        observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
        readOn(f.conn, subscription);
        observer.next({ tag: "Stop" });
        expect(f.stops()).toBe(1);
        expect(f.unsubscribe).toHaveBeenCalledTimes(1);
        // The host closing the ended stream afterwards adds no second stop.
        observer.complete();
        expect(vi.getTimerCount()).toBe(0);

        f.follow().observer.complete();
        vi.advanceTimersByTime(250);
        expect(f.stops()).toBe(2);
    });

    test("a cut follow logs its state and the stop it schedules, and the refollow logs the gap", () => {
        vi.useFakeTimers();
        let observer: FollowObserver | undefined;
        let count = 0;
        const client = makeFakeClient({
            subscriptionId: () => `p:${++count}`,
            captureObserver: (o) => {
                observer = o;
            },
            deferMatch: (method) => method === "getHeadStorage",
        });
        const conn = createHostPapiProvider(client, "0xfeed")(() => {});

        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        vi.advanceTimersByTime(1000);
        observer?.next({ tag: "BestBlockChanged", value: { bestBlockHash: "0x01" } });
        conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_call",
            params: ["p:1", "0x01", "Core_version", "0x"],
        });
        conn.send({
            jsonrpc: "2.0",
            id: 3,
            method: "chainHead_v1_storage",
            params: ["p:1", "0x01", [{ key: "0x00", type: "value" }], null],
        });
        vi.advanceTimersByTime(2000);
        observer?.error(new Error("transport closed"));
        vi.advanceTimersByTime(350);
        conn.send({ jsonrpc: "2.0", id: 4, method: "chainHead_v1_follow", params: [true] });

        expect(lines).toEqual([
            "warn: chainHead follow p:1 interrupted (transport closed): up 3000 ms, 1 event, the last 2000 ms ago, 2 operations in flight, stop in 250 ms",
            "warn: chainHead follow p:2 restarted 100 ms after the stop",
        ]);
    });

    test("a Stop from the host and an unfollow log the follow's state; the first follow is no warning", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        const first = f.follow();
        first.observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
        readOn(f.conn, first.subscription);
        vi.advanceTimersByTime(6000);
        first.observer.next({ tag: "Stop" });
        vi.advanceTimersByTime(10);
        const second = f.follow();
        vi.advanceTimersByTime(500);
        f.unfollow(second.subscription);

        expect(lines).toEqual([
            "warn: chainHead follow p:1 stopped by the host: up 6000 ms, 1 event, the last 6000 ms ago, 0 operations in flight",
            "warn: chainHead follow p:2 restarted 10 ms after the stop",
            "warn: chainHead follow p:2 unfollowed: up 500 ms, no events, 0 operations in flight",
        ]);
    });

    test("unfollow cancels a pending synthetic stop", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        const { subscription, observer } = f.follow();
        observer.complete();
        expect(vi.getTimerCount()).toBe(1);
        f.unfollow(subscription);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(4000);
        expect(f.stops()).toBe(0);
        expect(f.messages[f.messages.length - 1]).toEqual({ jsonrpc: "2.0", id: 2, result: null });
    });

    test("disconnect cancels every pending synthetic stop and ignores later requests", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        f.follow().observer.complete();
        expect(vi.getTimerCount()).toBe(1);
        f.conn.disconnect();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(4000);
        f.follow();
        expect(f.observers).toHaveLength(1);
        expect(f.stops()).toBe(0);
    });

    /** Fake timers, plus the callbacks they were given: a callback can then run after its clearTimeout. */
    function captureTimerCallbacks() {
        vi.useFakeTimers();
        const spy = vi.spyOn(globalThis, "setTimeout");
        return {
            callbacks: () => spy.mock.calls.map(([callback]) => callback as () => void),
            restore: () => spy.mockRestore(),
        };
    }

    test("a synthetic-stop callback already queued when unfollow cleared it emits nothing", () => {
        const timers = captureTimerCallbacks();
        const f = interruptibleFollows();
        const { subscription, observer } = f.follow();
        observer.complete();
        const [queued] = timers.callbacks();
        expect(queued).toBeDefined();
        f.unfollow(subscription);
        expect(vi.getTimerCount()).toBe(0);
        // clearTimeout cannot recall a callback the event loop already queued: run it anyway.
        queued!();
        observer.complete();
        expect(f.stops()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        timers.restore();
    });

    test("a stop or follow callback already queued when disconnect cleared it does nothing", () => {
        const timers = captureTimerCallbacks();
        const f = interruptibleFollows();
        const { observer } = f.follow();
        observer.complete();
        // Following again releases the interrupted follow and waits to open.
        f.follow();
        const queued = timers.callbacks();
        expect(queued).toHaveLength(2);
        f.conn.disconnect();
        expect(vi.getTimerCount()).toBe(0);
        // clearTimeout cannot recall callbacks the event loop already queued: run them anyway.
        for (const callback of queued) callback();
        observer.complete();
        expect(f.stops()).toBe(0);
        expect(f.observers).toHaveLength(1);
        timers.restore();
    });

    /** A follow whose call reads lose the follow unless `rejections` is given, and the host calls it received. */
    function followWithFailingReads(
        options: {
            unsubscribe?: () => void;
            deferMatch?: (method: string, resolve: () => unknown) => boolean;
            rejections?: Record<string, unknown>;
        } = {},
    ) {
        const observers: FollowObserver[] = [];
        const unsubscribe = vi.fn(options.unsubscribe);
        const hostCalls: string[] = [];
        const client = makeFakeClient({
            unsubscribe,
            errors: options.rejections ? undefined : { callHead: lostFollow },
            rejections: options.rejections,
            deferMatch: options.deferMatch,
            onCall: (method) => hostCalls.push(method),
            captureObserver: (o) => observers.push(o),
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((m) => messages.push(m));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        messages.length = 0;
        const read = (id: number) =>
            conn.send({
                jsonrpc: "2.0",
                id,
                method: "chainHead_v1_call",
                params: ["p:41", "0xhash", "Core_version", "0x"],
            });
        return { conn, messages, observers, unsubscribe, hostCalls, read };
    }

    const lostFollow = {
        tag: "HostFailure",
        value: { reason: 'remote_chain_head_call: unknown follow subscription id "c1:host:41"' },
    };
    const stopEvent = {
        jsonrpc: "2.0",
        method: "chainHead_v1_followEvent",
        params: { subscription: "p:41", result: { event: "stop" } },
    };
    const heldAnswer = (id: number) => ({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "chainHead follow p:41 ended" },
    });
    const lostFollowAnswer = (id: number) => ({
        jsonrpc: "2.0",
        id,
        error: {
            code: -32603,
            message:
                'HostFailure: remote_chain_head_call: unknown follow subscription id "c1:host:41"',
        },
    });

    function refollow(
        f: { conn: JsonRpcConnection; messages: JsonRpcMessage[]; observers: FollowObserver[] },
        id: number,
    ): void {
        f.conn.send({ jsonrpc: "2.0", id, method: "chainHead_v1_follow", params: [true] });
        f.observers.at(-1)?.next({
            tag: "Initialized",
            value: { finalizedBlockHashes: ["0x01"] },
        });
        f.messages.length = 0;
    }

    /** Read on a lost follow, let its stop out, and follow again up to an Initialized item. */
    function loseAndRefollow(f: ReturnType<typeof followWithFailingReads>, id: number): void {
        f.messages.length = 0;
        f.read(id);
        vi.advanceTimersByTime(4000);
        expect(f.messages).toEqual([stopEvent, heldAnswer(id)]);
        refollow(f, id + 100);
    }

    /** Expect `expected` once `delay` ms have passed, and nothing a millisecond before. */
    function expectAfter(messages: JsonRpcMessage[], delay: number, expected: unknown[]): void {
        vi.advanceTimersByTime(delay - 1);
        expect(messages).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(messages).toEqual(expected);
    }

    test("a read on a lost follow stays unanswered until the stop is out", () => {
        vi.useFakeTimers();
        const f = followWithFailingReads();

        f.read(2);
        expect(f.messages).toEqual([]);
        expect(f.unsubscribe).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(250);
        expect(f.messages).toEqual([stopEvent, heldAnswer(2)]);
    });

    test("a read sent after the follow was interrupted goes no further than the provider", () => {
        vi.useFakeTimers();
        const f = followWithFailingReads();
        f.observers[0]?.error(new Error("transport closed"));

        f.read(2);
        f.read(3);
        expect(f.hostCalls).toEqual([]);
        expect(f.messages).toEqual([]);

        vi.advanceTimersByTime(250);
        expect(f.messages).toEqual([stopEvent, heldAnswer(2), heldAnswer(3)]);
    });

    test.each([
        ["header", "chainHead_v1_header", ["p:41", "0xhash"]],
        ["body", "chainHead_v1_body", ["p:41", "0xhash"]],
        [
            "storage",
            "chainHead_v1_storage",
            ["p:41", "0xhash", [{ key: "0x01", type: "value" }], null],
        ],
        ["call", "chainHead_v1_call", ["p:41", "0xhash", "Core_version", "0x"]],
    ])(
        "a %s read sent while the stop is pending never reaches the host",
        (_label, method, params) => {
            vi.useFakeTimers();
            const f = followWithFailingReads();
            f.observers[0]?.error(new Error("transport closed"));

            f.conn.send({ jsonrpc: "2.0", id: 2, method, params });
            expect(f.hostCalls).toEqual([]);
            expect(f.messages).toEqual([]);

            vi.advanceTimersByTime(250);
            expect(f.messages).toEqual([stopEvent, heldAnswer(2)]);
        },
    );

    test("unfollow answers the reads held for its follow", () => {
        vi.useFakeTimers();
        const f = followWithFailingReads();
        f.read(2);

        f.conn.send({ jsonrpc: "2.0", id: 3, method: "chainHead_v1_unfollow", params: ["p:41"] });

        expect(f.messages).toEqual([{ jsonrpc: "2.0", id: 3, result: null }, heldAnswer(2)]);
        vi.advanceTimersByTime(4000);
        expect(f.messages).toHaveLength(2);
    });

    test("unfollow answers the held reads when its unsubscribe throws", () => {
        vi.useFakeTimers();
        const f = followWithFailingReads({
            unsubscribe: () => {
                throw new Error("provider already closed");
            },
        });
        f.read(2);

        f.conn.send({ jsonrpc: "2.0", id: 3, method: "chainHead_v1_unfollow", params: ["p:41"] });

        expect(f.messages).toEqual([{ jsonrpc: "2.0", id: 3, result: null }, heldAnswer(2)]);
        expect(lines).toContain("warn: chainHead follow p:41: unsubscribe failed on unfollow");
    });

    test("disconnect drops the held reads without answering them", () => {
        vi.useFakeTimers();
        const f = followWithFailingReads();
        f.read(2);

        f.conn.disconnect();
        vi.advanceTimersByTime(4000);

        expect(f.messages).toEqual([]);
    });

    test("a lost-follow answer for an id this provider never issued fails at once", () => {
        const f = followWithFailingReads();

        f.conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_call",
            params: ["p:other", "0xhash", "Core_version", "0x"],
        });

        expect(f.messages).toEqual([lostFollowAnswer(2)]);
    });

    test("a host that keeps losing the follow is refollowed at a growing pace", () => {
        vi.useFakeTimers();
        const f = followWithFailingReads();

        for (const [index, delay] of [250, 500, 1000, 2000, 4000, 4000].entries()) {
            const id = index + 2;
            f.read(id);
            expectAfter(f.messages, delay, [stopEvent, heldAnswer(id)]);
            refollow(f, id + 100);
        }

        expect(f.unsubscribe).toHaveBeenCalledTimes(6);
    });

    test.each([
        ["body", "chainHead_v1_body"],
        ["header", "chainHead_v1_header"],
    ])("after a %s read the host answers, refollows start again at 250 ms", (_label, method) => {
        vi.useFakeTimers();
        const f = followWithFailingReads();
        loseAndRefollow(f, 2);
        loseAndRefollow(f, 3);
        f.conn.send({ jsonrpc: "2.0", id: 4, method, params: ["p:41", "0xhash"] });
        f.messages.length = 0;

        f.observers.at(-1)?.error(new Error("transport closed"));
        expectAfter(f.messages, 250, [stopEvent]);
        refollow(f, 5);
        f.observers.at(-1)?.error(new Error("transport closed"));

        // That refollow only initialized, which does not show the host is steady.
        expectAfter(f.messages, 500, [stopEvent]);
    });

    test("a read the host answers while the stop is pending does not bring the refollow pace back", () => {
        vi.useFakeTimers();
        let answerHeader: (() => unknown) | undefined;
        const f = followWithFailingReads({
            deferMatch: (method, resolve) => {
                if (method !== "getHeadHeader") return false;
                answerHeader = resolve;
                return true;
            },
        });
        f.conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_header",
            params: ["p:41", "0xhash"],
        });
        f.read(3);

        expect(answerHeader).toBeDefined();
        answerHeader?.();
        expect(f.messages).toEqual([{ jsonrpc: "2.0", id: 2, result: "0x01" }]);
        f.messages.length = 0;
        expectAfter(f.messages, 250, [stopEvent, heldAnswer(3)]);
        refollow(f, 4);
        f.read(5);

        expectAfter(f.messages, 500, [stopEvent, heldAnswer(5)]);
    });

    test("a read the host answers after the stop does not bring the refollow pace back", () => {
        vi.useFakeTimers();
        let follows = 0;
        let answerHeader: (() => unknown) | undefined;
        const client = makeFakeClient({
            errors: { callHead: lostFollow },
            subscriptionId: () => `p:${++follows}`,
            deferMatch: (method, resolve) => {
                if (method !== "getHeadHeader") return false;
                answerHeader = resolve;
                return true;
            },
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((m) => messages.push(m));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_header",
            params: ["p:1", "0xhash"],
        });
        conn.send({
            jsonrpc: "2.0",
            id: 3,
            method: "chainHead_v1_call",
            params: ["p:1", "0xhash", "Core_version", "0x"],
        });
        vi.advanceTimersByTime(250);
        conn.send({ jsonrpc: "2.0", id: 4, method: "chainHead_v1_follow", params: [true] });

        expect(answerHeader).toBeDefined();
        answerHeader?.();
        conn.send({
            jsonrpc: "2.0",
            id: 5,
            method: "chainHead_v1_call",
            params: ["p:2", "0xhash", "Core_version", "0x"],
        });
        messages.length = 0;

        expectAfter(messages, 500, [
            {
                jsonrpc: "2.0",
                method: "chainHead_v1_followEvent",
                params: { subscription: "p:2", result: { event: "stop" } },
            },
            {
                jsonrpc: "2.0",
                id: 5,
                error: { code: -32603, message: "chainHead follow p:2 ended" },
            },
        ]);
    });

    test("a read the host rejects after the follow stream drops waits for the stop and is not counted as lost", async () => {
        vi.useFakeTimers();
        const { ConnectionResetError } = await import("@parity/truapi");
        const f = followWithFailingReads({
            rejections: { callHead: new ConnectionResetError() },
        });
        f.observers.at(-1)?.next({
            tag: "Initialized",
            value: { finalizedBlockHashes: ["0x01"] },
        });
        f.messages.length = 0;
        f.read(2);

        f.observers.at(-1)?.error(new Error("transport closed"));
        await vi.advanceTimersByTimeAsync(0);
        expectAfter(f.messages, 250, [stopEvent, heldAnswer(2)]);
        refollow(f, 3);
        // A follow's age counts as steady only while no read is counted as lost.
        vi.advanceTimersByTime(STEADY_FOLLOW_MS);
        f.observers.at(-1)?.error(new Error("transport closed"));

        expectAfter(f.messages, 250, [stopEvent]);
    });

    test("a read the host fails with any error after the follow stream drops waits for the stop", async () => {
        vi.useFakeTimers();
        const f = followWithFailingReads({
            rejections: { callHead: new Error("boom") },
        });
        f.read(2);

        f.observers.at(-1)?.error(new Error("transport closed"));
        await vi.advanceTimersByTimeAsync(0);

        expectAfter(f.messages, 250, [stopEvent, heldAnswer(2)]);
    });

    test("a read on a lost follow whose unsubscribe throws still gets its stop", () => {
        vi.useFakeTimers();
        const f = followWithFailingReads({
            unsubscribe: () => {
                throw new Error("provider already closed");
            },
        });

        f.read(2);
        vi.advanceTimersByTime(250);

        expect(f.messages).toEqual([stopEvent, heldAnswer(2)]);
        expect(lines).toContain(
            "warn: chainHead follow p:41: unsubscribe failed after a lost read",
        );
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

    test("a host call that rejects still answers PAPI once, so a timed-out query cannot stall it", async () => {
        const timedOut = new Error("TrUAPI request host:9 (wire 3, 3) timed out after 120000ms");
        const client = makeFakeClient({
            rejections: { getHeadStorage: timedOut, unpinHead: timedOut, getHeadHeader: timedOut },
        });
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(client, "0xfeed")((message) => messages.push(message));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [false] });
        messages.length = 0;

        conn.send({
            jsonrpc: "2.0",
            id: 2,
            method: "chainHead_v1_storage",
            params: ["p:41", "0xhash", [{ key: "0x01", type: "value" }], null],
        });
        conn.send({
            jsonrpc: "2.0",
            id: 3,
            method: "chainHead_v1_unpin",
            params: ["p:41", ["0xhash"]],
        });
        conn.send({
            jsonrpc: "2.0",
            id: 4,
            method: "chainHead_v1_header",
            params: ["p:41", "0xhash"],
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const error = { code: -32603, message: expect.stringContaining(timedOut.message) };
        expect(messages).toEqual([
            { jsonrpc: "2.0", id: 2, error },
            { jsonrpc: "2.0", id: 3, error },
            { jsonrpc: "2.0", id: 4, error },
        ]);
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

    // --- one follow per chain per product ---

    /** A provider connection on `genesisHash` over its own fake host, with follows the test drives. */
    function connectionOn(genesisHash: `0x${string}`, { refollowOnStop = false } = {}) {
        const observers: FollowObserver[] = [];
        let count = 0;
        let id = 0;
        const client = makeFakeClient({
            subscriptionId: () => `${genesisHash}:${++count}`,
            captureObserver: (o) => observers.push(o),
        });
        const followRequest = () => ({
            jsonrpc: "2.0" as const,
            id: ++id,
            method: "chainHead_v1_follow",
            params: [true],
        });
        // A consumer that follows again as soon as its follow stops, as polkadot-api does.
        const conn = createHostPapiProvider(
            client,
            genesisHash,
        )((message) => {
            const event =
                "params" in message
                    ? (message.params as { result?: FollowEvent }).result
                    : undefined;
            if (refollowOnStop && event?.event === "stop") conn.send(followRequest());
        });
        const follow = () => {
            conn.send(followRequest());
            return {
                subscription: `${genesisHash}:${count}`,
                observer: observers[observers.length - 1]!,
            };
        };
        const unfollow = (subscription: string) =>
            conn.send({
                jsonrpc: "2.0",
                id: ++id,
                method: "chainHead_v1_unfollow",
                params: [subscription],
            });
        /** Initialize the follow and answer a read on it, so a Stop on it is forwarded at once. */
        const steady = (follow: { subscription: string; observer: FollowObserver }) => {
            follow.observer.next(initialized);
            readOn(conn, follow.subscription);
        };
        return { conn, follow, unfollow, steady };
    }

    const followErrors = () => lines.filter((line) => line.startsWith("error: chain "));
    const initialized = { tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } };
    const extraFollows = (n: number) =>
        `error: chain 0xfeed now has ${n} follows from this product: share one client per chain (createChainClient / getClient) instead of creating another.`;

    test("a second connection following a chain this product already follows is one error", () => {
        const first = connectionOn("0xfeed");
        first.follow();
        expect(followErrors()).toEqual([]);

        const second = connectionOn("0xfeed");
        second.follow();
        expect(followErrors()).toEqual([extraFollows(2)]);

        // More follows on a connection already counted are the same client.
        second.follow();
        first.follow();
        expect(followErrors()).toEqual([extraFollows(2)]);

        // Each further connection is one more client, reported with its count.
        connectionOn("0xfeed").follow();
        expect(followErrors()).toEqual([extraFollows(2), extraFollows(3)]);
    });

    test("connections following different chains are no error", () => {
        connectionOn("0xfeed").follow();
        connectionOn("0xbeef").follow();
        connectionOn("0xcafe").follow();
        expect(followErrors()).toEqual([]);
    });

    test("one connection that follows again after a Stop is no error", () => {
        const c = connectionOn("0xfeed");
        const first = c.follow();
        c.steady(first);
        first.observer.next({ tag: "Stop" });
        const next = c.follow();
        c.steady(next);
        next.observer.next({ tag: "Stop" });
        expect(followErrors()).toEqual([]);
    });

    test("one connection that follows again while its lost follow waits for its stop is no error", () => {
        vi.useFakeTimers();
        const c = connectionOn("0xfeed");
        const { observer } = c.follow();
        observer.error(new Error("transport closed"));
        // Following again before the stop abandons the old follow, which is released.
        c.follow();
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        expect(followErrors()).toEqual([]);
    });

    test("a stop on either of two connections, answered with a refollow at once, is not reported again", () => {
        const first = connectionOn("0xfeed", { refollowOnStop: true });
        const one = first.follow();
        const second = connectionOn("0xfeed", { refollowOnStop: true });
        const other = second.follow();
        expect(followErrors()).toEqual([extraFollows(2)]);

        first.steady(one);
        second.steady(other);
        one.observer.next({ tag: "Stop" });
        other.observer.next({ tag: "Stop" });
        expect(followErrors()).toEqual([extraFollows(2)]);
    });

    test("a lost follow's stop on one of two connections, answered with a refollow at once, is not reported again", () => {
        vi.useFakeTimers();
        const first = connectionOn("0xfeed", { refollowOnStop: true });
        const { observer } = first.follow();
        connectionOn("0xfeed").follow();
        expect(followErrors()).toEqual([extraFollows(2)]);

        observer.error(new Error("transport closed"));
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        expect(followErrors()).toEqual([extraFollows(2)]);
    });

    test("a connection whose only follow stops leaves the chain, so the next connection is no error", () => {
        vi.useFakeTimers();
        const only = connectionOn("0xfeed");
        const follow = only.follow();
        only.steady(follow);
        follow.observer.next({ tag: "Stop" });
        connectionOn("0xfeed").follow();
        expect(followErrors()).toEqual([]);

        connectionOn("0xbeef").follow().observer.error(new Error("transport closed"));
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        connectionOn("0xbeef").follow();
        expect(followErrors()).toEqual([]);
    });

    test("a connection that unfollows its last follow leaves the chain, so the next connection is no error", () => {
        const first = connectionOn("0xfeed");
        const { subscription } = first.follow();
        first.unfollow(subscription);
        connectionOn("0xfeed").follow();
        expect(followErrors()).toEqual([]);
    });

    test("the second connection closing and a new one opening is an error again", () => {
        const first = connectionOn("0xfeed");
        first.follow();
        const second = connectionOn("0xfeed");
        second.follow();
        expect(followErrors()).toEqual([extraFollows(2)]);

        // The chain is back to one client, so a new second client is a new episode:
        // it is reported, since the product has made another extra client.
        second.conn.disconnect();
        connectionOn("0xfeed").follow();
        expect(followErrors()).toEqual([extraFollows(2), extraFollows(2)]);
    });

    test("in a production build a second connection is no error", () => {
        vi.stubEnv("NODE_ENV", "production");
        try {
            connectionOn("0xfeed").follow();
            connectionOn("0xfeed").follow();
            expect(followErrors()).toEqual([]);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    // Issue #543: a connection holds one follow, every follow is paced, and a
    // loop costs a bounded number of warn lines.

    /** Expect one more stop once `delay` ms have passed, and none a millisecond before. */
    function expectStopAfter(f: ReturnType<typeof interruptibleFollows>, delay: number): void {
        const before = f.stops();
        vi.advanceTimersByTime(delay - 1);
        expect(f.stops()).toBe(before);
        vi.advanceTimersByTime(1);
        expect(f.stops()).toBe(before + 1);
    }

    const refused = () => new Error("Subscription interrupted");

    test("a second follow on one connection releases the first, and nothing more is sent for it", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        const first = f.follow();
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);

        f.follow();

        expect(f.unsubscribe).toHaveBeenCalledTimes(1);
        f.messages.length = 0;
        first.observer.next({ tag: "BestBlockChanged", value: { bestBlockHash: "0x01" } });
        first.observer.error(refused());
        vi.advanceTimersByTime(60_000);
        // A stop would make polkadot-api's abandoned follower follow again.
        expect(f.messages).toEqual([]);
    });

    test("a follow that replaces an interrupted one cancels its stop and leaves its held reads unanswered", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows({ errors: { callHead: lostFollow } });
        f.follow();
        f.conn.send({
            jsonrpc: "2.0",
            id: 50,
            method: "chainHead_v1_call",
            params: ["p:1", "0xhash", "Core_version", "0x"],
        });
        expect(vi.getTimerCount()).toBe(1);

        f.follow();
        vi.advanceTimersByTime(60_000);

        expect(f.stops()).toBe(0);
        // An error answer would reach polkadot-api's shared retry and restart the live follower.
        expect(f.messages.some((m) => (m as { id?: unknown }).id === 50)).toBe(false);
        expect(f.observers).toHaveLength(2);
    });

    test("a follow that replaces one opened sooner than the backoff waits, and a newer request takes its place", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        f.follow();
        vi.advanceTimersByTime(100);
        const follow = (id: number) =>
            f.conn.send({ jsonrpc: "2.0", id, method: "chainHead_v1_follow", params: [true] });

        follow(20);
        vi.advanceTimersByTime(50);
        follow(21);
        vi.advanceTimersByTime(99);
        expect(f.observers).toHaveLength(1);
        vi.advanceTimersByTime(1);

        expect(f.observers).toHaveLength(2);
        const answered = f.messages.filter((m) => "id" in m).map((m) => (m as { id: unknown }).id);
        // Request 20 was abandoned before it was opened, so it is never answered.
        expect(answered).toEqual([1, 21]);

        // The backoff doubled: the next replacement waits 500 ms from the last start.
        follow(22);
        vi.advanceTimersByTime(499);
        expect(f.observers).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(f.observers).toHaveLength(3);
    });

    test("disconnect drops a follow request that is waiting to be opened", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        f.follow();
        f.follow();
        expect(vi.getTimerCount()).toBe(1);

        f.conn.disconnect();

        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(60_000);
        expect(f.observers).toHaveLength(1);
    });

    test("a Stop from the host on a follow that never initialized is paced like an interrupt", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (const delay of [250, 500, 1000]) {
            const { observer } = f.follow();
            observer.next({ tag: "Stop" });
            // The host closing the ended stream afterwards adds no second stop.
            observer.complete();
            expectStopAfter(f, delay);
        }
        expect(f.unsubscribe).toHaveBeenCalledTimes(3);
    });

    /** Stop waits while follows keep ending before any event: 4 s until 8 in a row, then up to 30 s. */
    const REFUSED_DELAYS = [
        250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 8000, 16000, 30000, 30000,
    ];

    test("follows that keep ending before any event back off past 4 s after 8 in a row, up to 30 s", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (const delay of REFUSED_DELAYS) {
            f.follow().observer.error(refused());
            expectStopAfter(f, delay);
        }
    });

    test("a redial that cuts follows before any event keeps the 4 s cap for its first 8", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        // The core redialling a chain socket ends each follow with a plain completion.
        for (const delay of REFUSED_DELAYS.slice(0, 8)) {
            f.follow().observer.complete();
            expectStopAfter(f, delay);
        }
    });

    test("a connection reset keeps the 4 s cap", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        const reset = Object.assign(new Error("host link lost"), { name: "ConnectionResetError" });
        for (const delay of [250, 500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000]) {
            f.follow().observer.error(reset);
            expectStopAfter(f, delay);
        }
    });

    test("a follow the node accepts brings the cap back to 4 s and starts the count over", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (const delay of REFUSED_DELAYS.slice(0, 10)) {
            f.follow().observer.error(refused());
            expectStopAfter(f, delay);
        }

        const accepted = f.follow();
        accepted.observer.next({ tag: "BestBlockChanged", value: { bestBlockHash: "0x01" } });
        accepted.observer.error(refused());
        expectStopAfter(f, 4000);

        for (const delay of [4000, 4000, 4000]) {
            f.follow().observer.error(refused());
            expectStopAfter(f, delay);
        }
    });

    test("a follow loop writes its first interrupt and restart, then a line a minute, and says when it is steady", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        // Five minutes of refused follows, each followed again once its stop is out.
        for (let attempt = 0; attempt < 10; attempt++) {
            f.follow().observer.error(refused());
            vi.advanceTimersByTime(30_000);
        }
        const steady = f.follow();
        steady.observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
        readOn(f.conn, steady.subscription);

        expect(lines).toEqual([
            "warn: chainHead follow p:1 interrupted (Subscription interrupted): up 0 ms, no events, 0 operations in flight, stop in 250 ms",
            "warn: chainHead follow p:2 restarted 29750 ms after the stop",
            "warn: chainHead follows on this connection keep failing: 3 ended in 60 s, the stop backoff is now 2000 ms",
            "warn: chainHead follows on this connection keep failing: 5 ended in 120 s, the stop backoff is now 4000 ms",
            "warn: chainHead follows on this connection keep failing: 7 ended in 180 s, the stop backoff is now 4000 ms",
            "warn: chainHead follows on this connection keep failing: 9 ended in 240 s, the stop backoff is now 16000 ms",
            "warn: chainHead follow p:11 is steady after 10 ended follows in 300 s",
        ]);
    });

    test("follows a broken client keeps abandoning write one warn line, though each new one initializes", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (let attempt = 0; attempt < 5; attempt++) {
            f.follow().observer.next({
                tag: "Initialized",
                value: { finalizedBlockHashes: ["0x01"] },
            });
            vi.advanceTimersByTime(5000);
        }

        expect(lines).toEqual([
            "warn: chainHead follow p:1 released, its client followed again without unfollowing it: up 5000 ms, 1 event, the last 5000 ms ago, 0 operations in flight",
        ]);
    });

    test("an error for an abandoned follow's unpin is not answered", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows({ errors: { unpinHead: lostFollow } });
        f.follow();
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        f.follow();
        f.messages.length = 0;

        f.conn.send({
            jsonrpc: "2.0",
            id: 60,
            method: "chainHead_v1_unpin",
            params: ["p:1", ["0x01"]],
        });

        expect(f.messages).toEqual([]);
    });

    test("a lost host link after a run of refused follows waits at most 4 s for its stop", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (const delay of REFUSED_DELAYS.slice(0, 10)) {
            f.follow().observer.error(refused());
            expectStopAfter(f, delay);
        }
        const reset = Object.assign(new Error("host link lost"), { name: "ConnectionResetError" });

        f.follow().observer.error(reset);

        expectStopAfter(f, 4000);
    });

    test("an abandoned follow's late errors stay unanswered however many follows were released since", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows({ errors: { unpinHead: lostFollow } });
        for (let attempt = 0; attempt < 100; attempt++) {
            f.follow();
            vi.advanceTimersByTime(LONGEST_STOP_DELAY_MS);
        }
        f.messages.length = 0;

        f.conn.send({
            jsonrpc: "2.0",
            id: 70,
            method: "chainHead_v1_unpin",
            params: ["p:1", ["0x01"]],
        });

        expect(f.messages).toEqual([]);
    });

    test("a replacement that does not start leaves the chain, so the next connection is no error", () => {
        vi.useFakeTimers();
        let follows = 0;
        const client = makeFakeClient({ subscriptionId: () => (++follows === 1 ? "p:1" : "") });
        const conn = createHostPapiProvider(client, "0xfeed")(() => {});
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        conn.send({ jsonrpc: "2.0", id: 2, method: "chainHead_v1_follow", params: [true] });

        createHostPapiProvider(
            makeFakeClient({}),
            "0xfeed",
        )(() => {}).send({
            jsonrpc: "2.0",
            id: 1,
            method: "chainHead_v1_follow",
            params: [true],
        });

        expect(lines.filter((line) => line.startsWith("error: chain "))).toEqual([]);
    });

    test("a follow abandoned long after the last one starts a new run: a warn line, and no wait", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (let attempt = 0; attempt < 4; attempt++) {
            f.follow();
            vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS * 2 ** attempt);
        }
        vi.advanceTimersByTime(60_000);
        lines.length = 0;

        f.follow();

        expect(f.observers).toHaveLength(5);
        expect(lines).toEqual([
            "warn: chainHead follow p:4 released, its client followed again without unfollowing it: up 62000 ms, no events, 0 operations in flight",
        ]);
    });

    test("a host that stops every follow just after it initializes is paced, with bounded warn lines", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (const delay of [250, 500, 1000, 2000, 4000, 4000, 4000]) {
            const { observer } = f.follow();
            observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
            observer.next({ tag: "Stop" });
            expectStopAfter(f, delay);
        }

        expect(lines).toEqual([
            "warn: chainHead follow p:1 interrupted (stopped by the host before it was steady): up 0 ms, 1 event, the last 0 ms ago, 0 operations in flight, stop in 250 ms",
            "warn: chainHead follow p:2 restarted 0 ms after the stop",
        ]);
    });

    test("a follow that initializes and then drops keeps backing off, not 250 ms each time", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (const delay of [250, 500, 1000, 2000, 4000, 4000]) {
            const { observer } = f.follow();
            observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
            observer.complete();
            expectStopAfter(f, delay);
        }
    });

    test("a follow that stays up 10 s after it initializes shows the host is steady", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        for (const delay of [250, 500, 1000]) {
            f.follow().observer.complete();
            expectStopAfter(f, delay);
        }
        const lasting = f.follow();
        lasting.observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
        vi.advanceTimersByTime(10_000);

        lasting.observer.complete();

        expectStopAfter(f, 250);
    });

    test("a Stop from the host on a follow that stayed up 10 s is forwarded at once", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        const { observer } = f.follow();
        observer.next({ tag: "Initialized", value: { finalizedBlockHashes: ["0x01"] } });
        vi.advanceTimersByTime(10_000);

        observer.next({ tag: "Stop" });

        expect(f.stops()).toBe(1);
    });

    test("a read on an abandoned follow that the host fails is not answered", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows({ errors: { callHead: lostFollow } });
        f.follow();
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        f.follow();
        f.messages.length = 0;

        f.conn.send({
            jsonrpc: "2.0",
            id: 80,
            method: "chainHead_v1_call",
            params: ["p:1", "0xhash", "Core_version", "0x"],
        });
        vi.advanceTimersByTime(60_000);

        expect(f.messages).toEqual([]);
    });

    test.each([
        ["continue", "chainHead_v1_continue", "continueHead"],
        ["stopOperation", "chainHead_v1_stopOperation", "stopHeadOperation"],
    ])("an error for an abandoned follow's %s is not answered", (_label, method, hostMethod) => {
        vi.useFakeTimers();
        const f = interruptibleFollows({ errors: { [hostMethod]: lostFollow } });
        f.follow();
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        f.follow();
        f.messages.length = 0;

        f.conn.send({ jsonrpc: "2.0", id: 90, method, params: ["p:1", "op1"] });

        expect(f.messages).toEqual([]);
    });

    test("a clean unfollow starts the replacement pace over", () => {
        vi.useFakeTimers();
        const f = interruptibleFollows();
        f.follow();
        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);
        const second = f.follow();
        f.unfollow(second.subscription);
        f.follow();
        expect(f.observers).toHaveLength(3);

        f.follow();

        // 250 ms again, not the 500 ms the first replacement doubled it to.
        vi.advanceTimersByTime(249);
        expect(f.observers).toHaveLength(3);
        vi.advanceTimersByTime(1);
        expect(f.observers).toHaveLength(4);
    });

    test("a waiting follow whose host subscription throws answers its request with the error", () => {
        vi.useFakeTimers();
        const base = makeFakeClient({ subscriptionId: "p:1" });
        let follows = 0;
        const subscribe = base.chain.followHeadSubscribe;
        base.chain.followHeadSubscribe = (args: unknown) => {
            if (++follows === 2) throw new Error("host gone");
            return subscribe(args as Parameters<typeof subscribe>[0]);
        };
        const messages: JsonRpcMessage[] = [];
        const conn = createHostPapiProvider(base, "0xfeed")((m) => messages.push(m));
        conn.send({ jsonrpc: "2.0", id: 1, method: "chainHead_v1_follow", params: [true] });
        conn.send({ jsonrpc: "2.0", id: 2, method: "chainHead_v1_follow", params: [true] });

        vi.advanceTimersByTime(SHORTEST_STOP_DELAY_MS);

        expect(messages.at(-1)).toEqual({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32603, message: "host gone" },
        });
        expect(lines).toContain("warn: chainHead_v1_follow: opening a waiting follow threw");
    });
}
