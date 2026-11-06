// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Query keys for every read/live hook in `@parity/product-sdk-react` and
 * `@parity/product-sdk-vue`, exported so apps can prefetch, invalidate or read hook
 * data straight from their TanStack QueryClient:
 *
 * ```ts
 * queryClient.invalidateQueries({ queryKey: queryKeys.balance("assetHub", address) });
 * queryClient.invalidateQueries({ queryKey: ["product-sdk", "balance", { chain: "assetHub" }] });
 * queryClient.invalidateQueries({ queryKey: queryKeys.root }); // everything
 * ```
 *
 * The parameter object is always the last key element, so partial filters
 * (TanStack's `partialDeepEqual` matching) work on any subset of it.
 */

export type QueryKeyPart = string | number | boolean | null;

/** Make any value usable inside a query key: bigint-safe, deterministic. */
export function toKeyPart(value: unknown): QueryKeyPart {
    if (value === undefined || value === null) return null;
    switch (typeof value) {
        case "string":
        case "number":
        case "boolean":
            return value;
        case "bigint":
            return `${value}n`;
        default:
            return (
                JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v)) ?? null
            );
    }
}

/**
 * Deterministic hash for a query key, matching TanStack's `hashKey` semantics
 * (object keys sorted) but bigint-safe. Used to identify shared live
 * subscriptions.
 */
export function hashQueryKey(key: readonly unknown[]): string {
    return JSON.stringify(key, (_k, value) => {
        if (typeof value === "bigint") return `${value}n`;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            return Object.keys(value)
                .sort()
                .reduce<Record<string, unknown>>((acc, k) => {
                    acc[k] = (value as Record<string, unknown>)[k];
                    return acc;
                }, {});
        }
        return value;
    });
}

export const queryKeys = {
    root: ["product-sdk"] as const,

    // chain
    chainClient: (chain: string) => ["product-sdk", "chainClient", { chain }] as const,
    typedApi: (chain: string) => ["product-sdk", "typedApi", { chain }] as const,
    chainQuery: (chain: string, deps: readonly unknown[]) =>
        ["product-sdk", "chainQuery", { chain, deps: deps.map(toKeyPart) }] as const,
    chainSubscription: (chain: string, deps: readonly unknown[]) =>
        ["product-sdk", "chainSubscription", { chain, deps: deps.map(toKeyPart) }] as const,
    blockNumber: (chain: string) => ["product-sdk", "blockNumber", { chain }] as const,
    balance: (chain: string, address: string | null) =>
        ["product-sdk", "balance", { chain, address }] as const,
    chainSpec: (chain: string) => ["product-sdk", "chainSpec", { chain }] as const,

    // host
    featureSupported: (feature: unknown) =>
        ["product-sdk", "featureSupported", { feature: toKeyPart(feature) }] as const,
    hostStorage: (key: string) => ["product-sdk", "hostStorage", { key }] as const,
    hostInfo: () => ["product-sdk", "hostInfo"] as const,
    productContext: () => ["product-sdk", "productContext"] as const,
    hostChainInfo: (identifiers: readonly string[]) =>
        ["product-sdk", "hostChainInfo", { identifiers: [...identifiers].sort() }] as const,

    // accounts
    userId: () => ["product-sdk", "userId"] as const,
    ringVrfKeys: (owner: string | null, disclosure: string) =>
        ["product-sdk", "ringVrfKeys", { owner, disclosure }] as const,

    // preimage
    preimage: (key: string | null) => ["product-sdk", "preimage", { key }] as const,

    // pocket
    pocketCards: () => ["product-sdk", "pocketCards"] as const,

    // contracts
    contract: (chain: string, manifest: QueryKeyPart, library: string, live: boolean) =>
        ["product-sdk", "contract", { chain, manifest, library, live }] as const,
    contractAt: (chain: string, address: string | null) =>
        ["product-sdk", "contractAt", { chain, address }] as const,
    contractQuery: (contract: QueryKeyPart, method: string, args: readonly unknown[]) =>
        ["product-sdk", "contractQuery", { contract, method, args: args.map(toKeyPart) }] as const,

    // chat
    chatRoom: (roomId: string) => ["product-sdk", "chatRoom", { roomId }] as const,
    chatBot: (botId: string) => ["product-sdk", "chatBot", { botId }] as const,
    chatRooms: () => ["product-sdk", "chatRooms"] as const,
    chatMessages: (roomId: string | null) => ["product-sdk", "chatMessages", { roomId }] as const,

    // statements
    statements: (topic2: string | null) => ["product-sdk", "statements", { topic2 }] as const,

    // payments
    paymentBalance: (purse: QueryKeyPart) => ["product-sdk", "paymentBalance", { purse }] as const,
    paymentStatus: (paymentId: string) => ["product-sdk", "paymentStatus", { paymentId }] as const,

    // cloud storage
    cid: (cid: string | null, json: boolean) => ["product-sdk", "cid", { cid, json }] as const,
    storageAuthorization: (address: string | null) =>
        ["product-sdk", "storageAuthorization", { address }] as const,
} as const;
