// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Where the DotNS contract addresses come from.
 *
 * Every entry point in `./dotns-registry.js` asks {@link resolveDotNsAddresses}
 * rather than reaching for a constant, so "which address do I call?" has one
 * answer and the gateway walk can plug in behind it without touching them.
 */
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { type Result, ok } from "@parity/result";
import { DOTNS_ADDRESSES } from "./dotns-abis.js";
import type { DotNsError } from "./dotns-errors.js";
import type { DotNsClientOptions } from "./dotns-registry.js";

type HexString = `0x${string}`;

export interface DotNsAddresses {
    registry: HexString;
    reverseResolver: HexString;
    resolver: HexString;
    registrarController: HexString;
    popRules: HexString;
    protocolRegistry: HexString;
}

/**
 * The `DotnsProtocolRegistry.get(bytes32)` key each role answers under, from
 * `DotnsConstants`. Solidity's `bytes32("name")` is the UTF-8 bytes
 * right-padded with zeros, which is what these literals are.
 *
 * Two are not the name you would guess, and guessing wrong is silent: `get`
 * answers with a live address for the contract you did not want, and it
 * surfaces much later as a revert. `registrarController` is the commit-reveal
 * controller, key `controller` — `registrar` is the ERC-721 holding name
 * ownership. `resolver` is the forward address resolver — `contentResolver`
 * holds contenthash and text records, which nothing here calls.
 *
 * `protocolRegistry` has no key at all, so it cannot be looked up in the
 * registry it is. The walk reaches it via `popController.protocolRegistry()`.
 */
export const DOTNS_REGISTRY_KEYS = {
    registry: "0x7265676973747279000000000000000000000000000000000000000000000000",
    registrarController: "0x636f6e74726f6c6c657200000000000000000000000000000000000000000000",
    reverseResolver: "0x726576657273655265736f6c7665720000000000000000000000000000000000",
    resolver: "0x7265736f6c766572000000000000000000000000000000000000000000000000",
    popRules: "0x706f7052756c6573000000000000000000000000000000000000000000000000",
} as const satisfies Record<Exclude<keyof DotNsAddresses, "protocolRegistry">, HexString>;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isZero(addr: unknown): boolean {
    return typeof addr === "string" && addr.toLowerCase() === ZERO_ADDRESS;
}

/** viem checksums every decoded `address`, so a read is EIP-55 whatever the chain sent. */
export function sameAddress(a: unknown, b: unknown): boolean {
    return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** A per-runtime, per-key cache of chain reads that cannot change under us. */
export type RuntimeCache<T> = WeakMap<ContractRuntime, Map<string, Promise<Result<T, DotNsError>>>>;

/**
 * Read `key` once per runtime and hand every later caller the same answer.
 *
 * Stores the in-flight promise rather than the resolved value, so concurrent
 * first calls share one read instead of racing. A failed read is dropped from
 * the cache: those are usually the RPC blinking rather than the deployment
 * moving, and keeping one would strand the client for the life of the runtime.
 */
export function cachedPerRuntime<T>(
    cache: RuntimeCache<T>,
    runtime: ContractRuntime,
    key: string,
    load: () => Promise<Result<T, DotNsError>>,
): Promise<Result<T, DotNsError>> {
    let byKey = cache.get(runtime);
    if (!byKey) {
        byKey = new Map();
        cache.set(runtime, byKey);
    }
    const cached = byKey.get(key);
    if (cached) return cached;

    const pending = load();
    byKey.set(key, pending);
    pending.then((result) => {
        if (!result.ok) byKey?.delete(key);
    });
    return pending;
}

function withOverrides(base: DotNsAddresses, opts: DotNsClientOptions): DotNsAddresses {
    return {
        registry: opts.registryAddress ?? base.registry,
        reverseResolver: opts.reverseResolverAddress ?? base.reverseResolver,
        resolver: opts.resolverAddress ?? base.resolver,
        registrarController: opts.registrarControllerAddress ?? base.registrarController,
        popRules: opts.popRulesAddress ?? base.popRules,
        protocolRegistry: opts.protocolRegistryAddress ?? base.protocolRegistry,
    };
}

/**
 * Async because the discovered source reads the chain. The pinned source does
 * no IO, so a caller that only validates a name still pays nothing for it.
 */
export async function resolveDotNsAddresses(
    opts: DotNsClientOptions,
): Promise<Result<DotNsAddresses, DotNsError>> {
    return ok(withOverrides(DOTNS_ADDRESSES, opts));
}
