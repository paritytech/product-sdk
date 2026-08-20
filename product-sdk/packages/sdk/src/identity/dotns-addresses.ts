// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Where the DotNS contract addresses come from.
 *
 * Every entry point in `./dotns-registry.js` asks {@link resolveDotNsAddresses}
 * rather than reaching for a constant, so "which address do I call?" has one
 * answer and the gateway walk can plug in behind it without touching them.
 */
import {
    type AbiEntry,
    type ContractRuntime,
    QUERY_FALLBACK_ORIGIN,
    createContract,
} from "@parity/product-sdk-contracts";
import { type Result, err, ok } from "@parity/result";
import {
    DOTNS_ADDRESSES,
    DOTNS_POP_CONTROLLER_ABI,
    DOTNS_PROTOCOL_REGISTRY_ABI,
    DOTNS_ROOT_GATEWAY_DISPATCHER_ABI,
} from "./dotns-abis.js";
import { DotNsError } from "./dotns-errors.js";
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
    if (opts.addressSource !== "discovered") return ok(withOverrides(DOTNS_ADDRESSES, opts));

    // Cache the walk, not the merged set: two callers differing only in their
    // overrides must share one walk and still each get their own answer.
    const walked = await cachedPerRuntime(walkCache, opts.runtime, "discovered", () =>
        discoverDotNsAddresses(opts),
    );
    return walked.ok ? ok(withOverrides(walked.value, opts)) : walked;
}

/**
 * Reads `DotnsGateway.DispatcherAddress`, the pallet storage the walk starts
 * from. Structural because `ContractRuntime` does not declare it.
 */
export type DotNsGatewayQueryApi = {
    query: {
        DotnsGateway: {
            DispatcherAddress: {
                getValue: () => Promise<{ asHex(): string } | string | undefined>;
            };
        };
    };
};

const discoveryFailed = (step: string, cause?: unknown) =>
    err(new DotNsError("AddressDiscovery", `DotNS address discovery failed: ${step}`, { cause }));

function contractAt(opts: DotNsClientOptions, address: HexString, abi: AbiEntry[]) {
    // Same untyped-by-construction handle as dotns-registry's contractOf.
    return createContract(opts.runtime, address, abi as any) as any;
}

async function readAddress(
    contract: {
        [m: string]: { query: (o: object) => Promise<{ success: boolean; value: unknown }> };
    },
    method: string,
    origin: string,
): Promise<Result<HexString, DotNsError>> {
    const res = await contract[method].query({ origin });
    if (!res.success) return discoveryFailed(`${method}() failed`, res.value);
    const value = res.value;
    if (typeof value !== "string" || isZero(value)) {
        return discoveryFailed(`${method}() returned no address`);
    }
    return ok(value as HexString);
}

/** PAPI hands back H160 as a wrapper or a hex string depending on the major. */
function asH160(value: unknown): HexString | null {
    if (typeof value === "string") return value as HexString;
    if (value && typeof (value as { asHex?: unknown }).asHex === "function") {
        return (value as { asHex(): string }).asHex() as HexString;
    }
    return null;
}

function gatewayOf(opts: DotNsClientOptions): DotNsGatewayQueryApi | null {
    if (opts.gatewayApi) return opts.gatewayApi;
    const api = opts.runtime?.api as unknown as Partial<DotNsGatewayQueryApi> | undefined;
    const getValue = api?.query?.DotnsGateway?.DispatcherAddress?.getValue;
    return typeof getValue === "function" ? (api as DotNsGatewayQueryApi) : null;
}

/**
 * Locate the live deployment from chain state, trusting nothing pinned here.
 *
 * Pallet -> `dispatcher.TARGET()` -> `popController.protocolRegistry()` ->
 * `get(key)` per role. The first three are sequential because each answer is
 * the next call's address; the role reads are not, so they go together.
 *
 * A failed or zero read is always an error: falling back to the pinned table
 * would recreate the situation this exists to detect, and hide it better.
 */
export async function discoverDotNsAddresses(
    opts: DotNsClientOptions,
): Promise<Result<DotNsAddresses, DotNsError>> {
    try {
        const gateway = gatewayOf(opts);
        if (!gateway) {
            return discoveryFailed(
                "no DotnsGateway.DispatcherAddress storage on this runtime; pass opts.gatewayApi",
            );
        }
        const dispatcher = asH160(await gateway.query.DotnsGateway.DispatcherAddress.getValue());
        if (!dispatcher || isZero(dispatcher)) {
            return discoveryFailed("DotnsGateway.DispatcherAddress is unset");
        }

        const origin = opts.origin ?? QUERY_FALLBACK_ORIGIN;
        const target = await readAddress(
            contractAt(opts, dispatcher, DOTNS_ROOT_GATEWAY_DISPATCHER_ABI),
            "TARGET",
            origin,
        );
        if (!target.ok) return target;

        const protocolRegistry = await readAddress(
            contractAt(opts, target.value, DOTNS_POP_CONTROLLER_ABI),
            "protocolRegistry",
            origin,
        );
        if (!protocolRegistry.ok) return protocolRegistry;

        const registry = contractAt(opts, protocolRegistry.value, DOTNS_PROTOCOL_REGISTRY_ABI);
        const roles = Object.entries(DOTNS_REGISTRY_KEYS) as [
            keyof typeof DOTNS_REGISTRY_KEYS,
            HexString,
        ][];
        const found = await Promise.all(
            roles.map(async ([role, key]) => {
                const res = await registry.get.query(key, { origin });
                if (!res.success) return discoveryFailed(`get(${role}) failed`, res.value);
                const value = res.value;
                // A wrong key is not an error on chain: it returns address(0),
                // so the role name is the only clue the caller gets.
                if (typeof value !== "string" || isZero(value)) {
                    return discoveryFailed(`${role} is unset on the protocol registry`);
                }
                return ok([role, value as HexString] as const);
            }),
        );
        const failed = found.find((r) => !r.ok);
        if (failed && !failed.ok) return failed;

        const byRole = Object.fromEntries(found.flatMap((r) => (r.ok ? [r.value] : []))) as Omit<
            DotNsAddresses,
            "protocolRegistry"
        >;
        return ok({ ...byRole, protocolRegistry: protocolRegistry.value });
    } catch (cause) {
        return discoveryFailed("unexpected error", cause);
    }
}

const walkCache: RuntimeCache<DotNsAddresses> = new WeakMap();

/**
 * Walk the gateway and report every role whose live address differs from the
 * one this client would call. Meant for startup: it fails loudly once, rather
 * than making every later read pay for the check.
 */
export async function verifyDotNsAddresses(
    opts: DotNsClientOptions,
): Promise<Result<DotNsAddresses, DotNsError>> {
    const discovered = await discoverDotNsAddresses(opts);
    if (!discovered.ok) return discovered;

    const inUse = withOverrides(DOTNS_ADDRESSES, opts);
    const drift = (Object.keys(inUse) as (keyof DotNsAddresses)[])
        .filter((role) => !sameAddress(inUse[role], discovered.value[role]))
        .map((role) => `${role}: using ${inUse[role]}, chain says ${discovered.value[role]}`);

    return drift.length
        ? err(
              new DotNsError(
                  "AddressMismatch",
                  `DotNS addresses disagree with the deployment — ${drift.join("; ")}`,
              ),
          )
        : ok(inUse);
}
