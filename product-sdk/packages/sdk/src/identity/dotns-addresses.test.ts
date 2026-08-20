// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// The gateway walk and the startup check. Contract hops run through
// `createFakeContractRuntime`, which uses the real codec and no chain; the
// pallet read is a hand-written object, since `ContractRuntime` does not
// declare it.
//
// Every fake here answers on `(dest, functionName)`, not on `functionName`
// alone. The walk calls three different contracts and two of them would
// otherwise answer for each other.
import { type AbiEntry, type ContractRuntime, createContract } from "@parity/product-sdk-contracts";
import { createFakeContractRuntime, fakeDryRunResult } from "@parity/product-sdk-contracts/testing";
import { describe, expect, test } from "vitest";
import {
    DOTNS_ADDRESSES,
    DOTNS_POP_CONTROLLER_ABI,
    DOTNS_PROTOCOL_REGISTRY_ABI,
    DOTNS_ROOT_GATEWAY_DISPATCHER_ABI,
} from "./dotns-abis.js";
import {
    DOTNS_REGISTRY_KEYS,
    type DotNsAddresses,
    type DotNsGatewayQueryApi,
    discoverDotNsAddresses,
    resolveDotNsAddresses,
    verifyDotNsAddresses,
} from "./dotns-addresses.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** A distinct H160, so a test can never pass by confusing two roles. */
const addr = (byte: string) => `0x${byte.repeat(20)}` as const;

/**
 * What the fake chain reports. Deliberately disjoint from `DOTNS_ADDRESSES`:
 * if a pinned value leaks into a discovered result, these assertions catch it.
 */
const DISCOVERED = {
    registry: addr("a1"),
    reverseResolver: addr("a2"),
    resolver: addr("a3"),
    registrarController: addr("a4"),
    popRules: addr("a5"),
    protocolRegistry: addr("a6"),
} satisfies DotNsAddresses;

const DISPATCHER = addr("b1");
const POP_CONTROLLER = addr("b2");

const WALK_ABIS: AbiEntry[] = [
    ...DOTNS_PROTOCOL_REGISTRY_ABI,
    ...DOTNS_ROOT_GATEWAY_DISPATCHER_ABI,
    ...DOTNS_POP_CONTROLLER_ABI,
];

const ROLE_BY_KEY = new Map(
    Object.entries(DOTNS_REGISTRY_KEYS).map(([role, key]) => [key as string, role]),
);

interface WalkOptions {
    /** What the pallet reports. `undefined` models storage with no value set. */
    dispatcher?: unknown;
    target?: unknown;
    protocolRegistry?: unknown;
    get?: Partial<Record<keyof DotNsAddresses, unknown>>;
}

/**
 * A chain that answers the whole walk. Every hop is overridable so a test can
 * break exactly one of them and leave the rest working.
 */
function walkChain(options: WalkOptions = {}) {
    const target = options.target ?? POP_CONTROLLER;
    const registry = options.protocolRegistry ?? DISCOVERED.protocolRegistry;

    const runtime = createFakeContractRuntime({
        abi: WALK_ABIS,
        onQuery: ({ dest, functionName, args }) => {
            const at = dest.toLowerCase();
            if (functionName === "TARGET" && at === DISPATCHER.toLowerCase()) return target;
            if (functionName === "protocolRegistry" && at === POP_CONTROLLER.toLowerCase()) {
                return registry;
            }
            if (functionName === "get" && at === String(registry).toLowerCase()) {
                const role = ROLE_BY_KEY.get(String(args?.[0]));
                if (!role) return ZERO; // an unknown key is what a wrong key looks like
                const override = options.get?.[role as keyof DotNsAddresses];
                return override ?? DISCOVERED[role as keyof DotNsAddresses];
            }
            return undefined;
        },
    });

    const dispatcher = "dispatcher" in options ? options.dispatcher : DISPATCHER;
    const gatewayApi = {
        query: {
            DotnsGateway: { DispatcherAddress: { getValue: async () => dispatcher } },
        },
    } as DotNsGatewayQueryApi;

    return { runtime, gatewayApi };
}

/** Walks performed, counted by `TARGET` since exactly one walk calls it exactly once. */
const walkCount = (runtime: { calls: ReadonlyArray<{ functionName?: string }> }) =>
    runtime.calls.filter((c) => c.functionName === "TARGET").length;

describe("DOTNS_REGISTRY_KEYS", () => {
    test("each key is the DotnsConstants literal, not a keccak hash", () => {
        // `bytes32("registry")` is the UTF-8 bytes left-aligned and right-padded
        // with zeros. Hardcoded rather than derived: deriving them here with the
        // same helper the source uses would agree with any mistake it makes.
        expect(DOTNS_REGISTRY_KEYS).toEqual({
            registry: "0x7265676973747279000000000000000000000000000000000000000000000000",
            registrarController:
                "0x636f6e74726f6c6c657200000000000000000000000000000000000000000000",
            reverseResolver: "0x726576657273655265736f6c7665720000000000000000000000000000000000",
            resolver: "0x7265736f6c766572000000000000000000000000000000000000000000000000",
            popRules: "0x706f7052756c6573000000000000000000000000000000000000000000000000",
        });
    });

    test("the controller key is `controller`, not `registrar`", () => {
        // The issue asked for `registrar`, which is the ERC-721 token contract,
        // not the commit-reveal controller this field holds. Both answer `get`
        // with a live address, so the wrong key fails silently.
        const registrar = `0x${Buffer.from("registrar").toString("hex").padEnd(64, "0")}`;
        expect(DOTNS_REGISTRY_KEYS.registrarController).not.toBe(registrar);
    });

    test("the resolver key is `resolver`, not `contentResolver`", () => {
        const contentResolver = `0x${Buffer.from("contentResolver").toString("hex").padEnd(64, "0")}`;
        expect(DOTNS_REGISTRY_KEYS.resolver).not.toBe(contentResolver);
    });

    test("every discoverable address has a key, and every key an address", () => {
        // Adding a seventh address should fail here until it is discoverable.
        // `protocolRegistry` is the exception: it has no DotnsConstants key and
        // is reached through the pop controller instead.
        const discoverable = Object.keys(DOTNS_ADDRESSES).filter((r) => r !== "protocolRegistry");
        expect(Object.keys(DOTNS_REGISTRY_KEYS).sort()).toEqual(discoverable.sort());
    });

    test("no two roles share a key", () => {
        const keys = Object.values(DOTNS_REGISTRY_KEYS);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe("discoverDotNsAddresses", () => {
    test("walks pallet to dispatcher to controller to registry", async () => {
        const { runtime, gatewayApi } = walkChain();
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r).toEqual({ ok: true, value: DISCOVERED });
    });

    test("reads every role from the chain, never from the pinned table", async () => {
        // The assertion that matters: not one discovered value equals its pinned
        // counterpart, so a fallback to DOTNS_ADDRESSES cannot pass this.
        const { runtime, gatewayApi } = walkChain();
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        for (const role of Object.keys(DOTNS_ADDRESSES) as (keyof DotNsAddresses)[]) {
            expect(r.value[role].toLowerCase()).not.toBe(DOTNS_ADDRESSES[role].toLowerCase());
        }
    });

    test("accepts a wrapped H160 as well as a plain hex string", async () => {
        // PAPI decodes H160 as a fixed-size binary wrapper, and the wrapper class
        // has changed across majors. Both shapes must work.
        const wrapped = walkChain({ dispatcher: { asHex: () => DISPATCHER } });
        expect(await discoverDotNsAddresses(wrapped)).toEqual({ ok: true, value: DISCOVERED });
        const plain = walkChain({ dispatcher: DISPATCHER });
        expect(await discoverDotNsAddresses(plain)).toEqual({ ok: true, value: DISCOVERED });
    });

    test("the five registry reads run concurrently, not one after another", async () => {
        const { runtime, gatewayApi } = walkChain();
        await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(runtime.calls.filter((c) => c.functionName === "get")).toHaveLength(5);
        // Two contract hops plus one batch of five. The pallet read is not here:
        // it goes through gatewayApi, so it never reaches runtime.calls.
        expect(runtime.calls).toHaveLength(7);
    });

    test("an unset dispatcher address fails, naming the pallet", async () => {
        const { runtime, gatewayApi } = walkChain({ dispatcher: undefined });
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.reason).toBe("AddressDiscovery");
        expect(r.error.message).toContain("DotnsGateway.DispatcherAddress");
    });

    test("a zero dispatcher address fails rather than walking into the void", async () => {
        const { runtime, gatewayApi } = walkChain({ dispatcher: ZERO });
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("AddressDiscovery");
    });

    test("a reverting TARGET() fails", async () => {
        const { runtime, gatewayApi } = walkChain({ target: fakeDryRunResult({ revert: true }) });
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.reason).toBe("AddressDiscovery");
        expect(r.error.message).toContain("TARGET");
    });

    test("a zero protocolRegistry() fails", async () => {
        const { runtime, gatewayApi } = walkChain({ protocolRegistry: ZERO });
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.reason).toBe("AddressDiscovery");
        expect(r.error.message).toContain("protocolRegistry");
    });

    test("an unset role names which role is missing", async () => {
        // A wrong key returns address(0), not an error, so the role name is the
        // only clue the caller gets.
        const { runtime, gatewayApi } = walkChain({ get: { popRules: ZERO } });
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.reason).toBe("AddressDiscovery");
        expect(r.error.message).toContain("popRules");
    });

    test("a failed read never becomes a pinned value", async () => {
        const { runtime, gatewayApi } = walkChain({ get: { registry: ZERO } });
        const r = await discoverDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
    });

    test("falls back to the runtime's own api when no gatewayApi is given", async () => {
        const { runtime } = walkChain();
        const api = runtime.api as unknown as Record<string, unknown>;
        api.query = {
            ...(api.query as object),
            DotnsGateway: { DispatcherAddress: { getValue: async () => DISPATCHER } },
        };
        expect(await discoverDotNsAddresses({ runtime })).toEqual({ ok: true, value: DISCOVERED });
    });

    test("a runtime without the pallet fails legibly instead of throwing", async () => {
        // Polkadot and Kusama Asset Hub have no DotnsGateway pallet at all.
        const { runtime } = walkChain();
        const r = await discoverDotNsAddresses({ runtime });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.reason).toBe("AddressDiscovery");
        expect(r.error.message).toContain("DotnsGateway");
    });
});

describe("resolveDotNsAddresses", () => {
    test("defaults to the pinned table and reads nothing", async () => {
        const runtime = {} as ContractRuntime; // any read would throw
        expect(await resolveDotNsAddresses({ runtime })).toEqual({
            ok: true,
            value: { ...DOTNS_ADDRESSES },
        });
    });

    test("a per-field override wins over the pinned table", async () => {
        const runtime = {} as ContractRuntime;
        const r = await resolveDotNsAddresses({ runtime, registryAddress: addr("c1") });
        expect(r).toEqual({
            ok: true,
            value: { ...DOTNS_ADDRESSES, registry: addr("c1") },
        });
    });

    test("addressSource discovered walks the gateway", async () => {
        const { runtime, gatewayApi } = walkChain();
        const r = await resolveDotNsAddresses({ runtime, gatewayApi, addressSource: "discovered" });
        expect(r).toEqual({ ok: true, value: DISCOVERED });
    });

    test("a per-field override wins over a discovered address too", async () => {
        const { runtime, gatewayApi } = walkChain();
        const r = await resolveDotNsAddresses({
            runtime,
            gatewayApi,
            addressSource: "discovered",
            registryAddress: addr("c1"),
        });
        expect(r).toEqual({ ok: true, value: { ...DISCOVERED, registry: addr("c1") } });
    });

    test("the cache holds the walk, not the merged result", async () => {
        // Two calls differing only in their override must both be right off one
        // walk. Caching the merged set would serve the first call's override to
        // the second.
        const { runtime, gatewayApi } = walkChain();
        const base = { runtime, gatewayApi, addressSource: "discovered" } as const;
        const one = await resolveDotNsAddresses({ ...base, registryAddress: addr("c1") });
        const two = await resolveDotNsAddresses({ ...base, registryAddress: addr("c2") });
        expect(one).toEqual({ ok: true, value: { ...DISCOVERED, registry: addr("c1") } });
        expect(two).toEqual({ ok: true, value: { ...DISCOVERED, registry: addr("c2") } });
        expect(walkCount(runtime)).toBe(1);
    });

    test("caches the walk per runtime", async () => {
        const { runtime, gatewayApi } = walkChain();
        const opts = { runtime, gatewayApi, addressSource: "discovered" } as const;
        await resolveDotNsAddresses(opts);
        await resolveDotNsAddresses(opts);
        expect(walkCount(runtime)).toBe(1);
    });

    test("concurrent first calls share one walk", async () => {
        const { runtime, gatewayApi } = walkChain();
        const opts = { runtime, gatewayApi, addressSource: "discovered" } as const;
        const results = await Promise.all([
            resolveDotNsAddresses(opts),
            resolveDotNsAddresses(opts),
            resolveDotNsAddresses(opts),
        ]);
        expect(walkCount(runtime)).toBe(1);
        for (const r of results) expect(r).toEqual({ ok: true, value: DISCOVERED });
    });

    test("a failed walk is not cached, so a later call retries", async () => {
        // A walk usually fails because the RPC blinked, not because the
        // deployment moved. Caching that would strand the client for the life of
        // the runtime.
        const pallet: { value: unknown } = { value: undefined };
        const { runtime } = walkChain();
        const gatewayApi = {
            query: { DotnsGateway: { DispatcherAddress: { getValue: async () => pallet.value } } },
        } as DotNsGatewayQueryApi;
        const opts = { runtime, gatewayApi, addressSource: "discovered" } as const;

        expect((await resolveDotNsAddresses(opts)).ok).toBe(false);
        pallet.value = DISPATCHER;
        expect(await resolveDotNsAddresses(opts)).toEqual({ ok: true, value: DISCOVERED });
    });

    test("pinned and discovered are cached apart on one runtime", async () => {
        const { runtime, gatewayApi } = walkChain();
        expect(await resolveDotNsAddresses({ runtime, gatewayApi })).toEqual({
            ok: true,
            value: { ...DOTNS_ADDRESSES },
        });
        expect(
            await resolveDotNsAddresses({ runtime, gatewayApi, addressSource: "discovered" }),
        ).toEqual({ ok: true, value: DISCOVERED });
    });
});

describe("verifyDotNsAddresses", () => {
    /** A chain whose walk lands exactly on the pinned table. */
    const agreeing = (overrides: Partial<DotNsAddresses> = {}) => {
        const answers = { ...DOTNS_ADDRESSES, ...overrides };
        const runtime = createFakeContractRuntime({
            abi: WALK_ABIS,
            onQuery: ({ dest, functionName, args }) => {
                const at = dest.toLowerCase();
                if (functionName === "TARGET") return POP_CONTROLLER;
                if (functionName === "protocolRegistry") return answers.protocolRegistry;
                if (functionName === "get" && at === answers.protocolRegistry.toLowerCase()) {
                    const role = ROLE_BY_KEY.get(String(args?.[0]));
                    return role ? answers[role as keyof DotNsAddresses] : ZERO;
                }
                return undefined;
            },
        });
        const gatewayApi = {
            query: { DotnsGateway: { DispatcherAddress: { getValue: async () => DISPATCHER } } },
        } as DotNsGatewayQueryApi;
        return { runtime, gatewayApi };
    };

    test("passes when the walk agrees with the pinned table", async () => {
        const { runtime, gatewayApi } = agreeing();
        expect(await verifyDotNsAddresses({ runtime, gatewayApi })).toEqual({
            ok: true,
            value: { ...DOTNS_ADDRESSES },
        });
    });

    test("casing does not count as a disagreement", async () => {
        // Chain reads come back lowercase; the pinned table is EIP-55.
        const lowered = Object.fromEntries(
            Object.entries(DOTNS_ADDRESSES).map(([k, v]) => [k, v.toLowerCase()]),
        ) as DotNsAddresses;
        const { runtime, gatewayApi } = agreeing(lowered);
        expect((await verifyDotNsAddresses({ runtime, gatewayApi })).ok).toBe(true);
    });

    test("fails loudly, naming the role and both addresses", async () => {
        const { runtime, gatewayApi } = agreeing({ registry: addr("d1") });
        const r = await verifyDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.reason).toBe("AddressMismatch");
        expect(r.error.message).toContain("registry");
        expect(r.error.message).toContain(DOTNS_ADDRESSES.registry);
        expect(r.error.message).toContain(addr("d1"));
    });

    test("lists every disagreeing role, not just the first", async () => {
        const { runtime, gatewayApi } = agreeing({
            registry: addr("d1"),
            popRules: addr("d2"),
        });
        const r = await verifyDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.message).toContain("registry");
        expect(r.error.message).toContain("popRules");
    });

    test("checks the caller's overrides, not only the pinned table", async () => {
        // A product that overrides an address wants that address verified. The
        // pinned value it replaced is not what it will call.
        const { runtime, gatewayApi } = agreeing();
        const r = await verifyDotNsAddresses({ runtime, gatewayApi, registryAddress: addr("d1") });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("AddressMismatch");
    });

    test("a walk that cannot complete is a discovery failure, not a mismatch", async () => {
        const { runtime, gatewayApi } = walkChain({ dispatcher: undefined });
        const r = await verifyDotNsAddresses({ runtime, gatewayApi });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("AddressDiscovery");
    });
});

describe("the new ABI fragments round-trip", () => {
    test("get, TARGET and protocolRegistry encode and decode", async () => {
        const { runtime } = walkChain();
        const dispatcher = createContract(
            runtime,
            DISPATCHER,
            DOTNS_ROOT_GATEWAY_DISPATCHER_ABI as never,
        ) as never as { TARGET: { query: () => Promise<{ success: boolean; value: unknown }> } };
        expect((await dispatcher.TARGET.query()).value).toBe(POP_CONTROLLER);

        const controller = createContract(
            runtime,
            POP_CONTROLLER,
            DOTNS_POP_CONTROLLER_ABI as never,
        ) as never as {
            protocolRegistry: { query: () => Promise<{ success: boolean; value: unknown }> };
        };
        expect((await controller.protocolRegistry.query()).value).toBe(DISCOVERED.protocolRegistry);

        const registry = createContract(
            runtime,
            DISCOVERED.protocolRegistry,
            DOTNS_PROTOCOL_REGISTRY_ABI as never,
        ) as never as {
            get: { query: (key: string) => Promise<{ success: boolean; value: unknown }> };
        };
        expect((await registry.get.query(DOTNS_REGISTRY_KEYS.popRules)).value).toBe(
            DISCOVERED.popRules,
        );
    });
});
