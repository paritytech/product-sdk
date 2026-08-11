// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS registry reads and writes.
 *
 * DotNS is an ENS-style system on Asset Hub: a `DotnsRegistry` maps a node
 * (namehash) to a resolver + owner, a `DotnsResolver` maps a node to an
 * address, and a `DotnsReverseResolver` maps an account back to its name. All
 * are Revive contracts, reached via `@parity/product-sdk-contracts`'
 * `createContract(...).<method>.query(...)`. See the sdk-team design doc
 * (`docs/product-sdk/dotns-registry-support.md`).
 *
 * **Reads are wired; writes are not.** `resolveDotNs` / `reverseDotNs` /
 * `isDotNsAvailable` call chain. `registerDotNs` / `setDotNsRecord` still throw
 * `DotNsError("NotWired")`: registration is a commit → wait → reveal-and-pay
 * flow that warrants its own PR. `TODO(dotns-abi)` marks the write sites.
 *
 * Note: this deployment has no name-expiry concept (the registrar exposes no
 * expiry getter), so `DotNsRecord.expiresAt` is always omitted.
 */
import { err, ok, type Result } from "@parity/result";
import { type AbiEntry, createContract } from "@parity/product-sdk-contracts";
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { createLogger } from "@parity/product-sdk-logger";
import {
    DOTNS_REGISTRY_ABI,
    DOTNS_RESOLVER_ABI,
    DOTNS_REVERSE_RESOLVER_ABI,
    PASEO_ASSETHUB_DOTNS,
} from "./dotns-abis.js";
import { DotNsError } from "./dotns-errors.js";
import { isValidDotNsName, normalizeDotNsName } from "./dotns.js";
import { namehash } from "./dotns-namehash.js";
import type { DotNsRecord } from "./types.js";

const log = createLogger("identity:dotns");

type HexString = `0x${string}`;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Shared inputs for a DotNS registry call. */
export interface DotNsClientOptions {
    /** A contract runtime for the chain hosting DotNS (Asset Hub). */
    runtime: ContractRuntime;
    /** `DotnsRegistry` address. Defaults to the Paseo Asset Hub deployment. */
    registryAddress?: HexString;
    /** `DotnsReverseResolver` address. Defaults to the Paseo Asset Hub deployment. */
    reverseResolverAddress?: HexString;
}

/** Arguments for {@link registerDotNs}. */
export interface RegisterDotNsArgs {
    name: string;
    owner: string;
}

/** Arguments for {@link setDotNsRecord}. */
export interface SetRecordArgs {
    name: string;
    address: string;
}

const WRITES_NOT_WIRED =
    "DotNS writes (register / setRecord) are not wired yet — registration is a " +
    "commit-reveal-pay flow tracked as a follow-up. See dotns-registry.ts.";

function contractOf(runtime: ContractRuntime, address: HexString, abi: AbiEntry[]) {
    // biome-ignore lint/suspicious/noExplicitAny: createContract is generic over a
    // typed ABI def; our minimal literal ABIs are called by name via .query().
    return createContract(runtime, address, abi as any) as any;
}

function isZero(addr: unknown): boolean {
    return typeof addr === "string" && addr.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Resolve a DotNS name to its record (resolved address + owner).
 *
 * Path: `namehash(name)` → `registry.resolver(node)` → `resolver.addressOf(node)`,
 * with `registry.owner(node)` for the owner. `expiresAt` is omitted (no on-chain
 * expiry on this deployment).
 *
 * @returns `ok(record)`, `ok(null)` when the name has no resolver / resolves to
 *   the zero address (unregistered), or `err(DotNsError)`.
 */
export async function resolveDotNs(
    name: string,
    opts: DotNsClientOptions,
): Promise<Result<DotNsRecord | null, DotNsError>> {
    const normalized = normalizeDotNsName(name);
    if (!isValidDotNsName(normalized)) {
        return err(new DotNsError("InvalidName", `Invalid DotNS name: "${name}"`));
    }
    const node = namehash(normalized);
    const registryAddr = opts.registryAddress ?? PASEO_ASSETHUB_DOTNS.registry;
    log.debug("resolveDotNs", { name: normalized, node, registry: registryAddr });

    try {
        const registry = contractOf(opts.runtime, registryAddr as HexString, DOTNS_REGISTRY_ABI);

        const resolverRes = await registry.resolver.query(node);
        if (!resolverRes.success) {
            return err(new DotNsError("RegistryCall", "registry.resolver call failed"));
        }
        const resolverAddr = resolverRes.value as string;
        // No resolver set → the name isn't resolvable.
        if (isZero(resolverAddr)) return ok(null);

        const resolver = contractOf(opts.runtime, resolverAddr as HexString, DOTNS_RESOLVER_ABI);
        const [addrRes, ownerRes] = await Promise.all([
            resolver.addressOf.query(node),
            registry.owner.query(node),
        ]);
        if (!addrRes.success) {
            return err(new DotNsError("RegistryCall", "resolver.addressOf call failed"));
        }
        const address = addrRes.value as string;
        // Resolver present but no address record → treat as unregistered.
        if (isZero(address)) return ok(null);

        const owner = ownerRes.success ? (ownerRes.value as string) : address;
        return ok({ address, name: normalized, owner });
    } catch (cause) {
        return err(
            new DotNsError("RegistryCall", `DotNS resolve failed for "${normalized}"`, { cause }),
        );
    }
}

/**
 * Reverse-resolve an account to its primary DotNS name.
 *
 * Single call: `reverseResolver.nameOf(account)`. `ok(null)` when no primary
 * name is set (empty string on-chain).
 */
export async function reverseDotNs(
    address: string,
    opts: DotNsClientOptions,
): Promise<Result<string | null, DotNsError>> {
    const reverseAddr = opts.reverseResolverAddress ?? PASEO_ASSETHUB_DOTNS.reverseResolver;
    log.debug("reverseDotNs", { address, reverseResolver: reverseAddr });
    try {
        const reverse = contractOf(
            opts.runtime,
            reverseAddr as HexString,
            DOTNS_REVERSE_RESOLVER_ABI,
        );
        const res = await reverse.nameOf.query(address);
        if (!res.success) {
            return err(new DotNsError("RegistryCall", "reverseResolver.nameOf call failed"));
        }
        const name = res.value as string;
        return ok(name && name.length > 0 ? name : null);
    } catch (cause) {
        return err(
            new DotNsError("RegistryCall", `DotNS reverse failed for "${address}"`, { cause }),
        );
    }
}

/**
 * Whether a DotNS name is unregistered (available to claim).
 *
 * `ok(true)` iff {@link resolveDotNs} returns `ok(null)`. Registry failures
 * propagate as `err`.
 */
export async function isDotNsAvailable(
    name: string,
    opts: DotNsClientOptions,
): Promise<Result<boolean, DotNsError>> {
    const resolved = await resolveDotNs(name, opts);
    if (!resolved.ok) return resolved;
    return ok(resolved.value === null);
}

// ── Writes (not wired — follow-up PR) ────────────────────────────────
//
// Registration is a commit → wait(minCommitmentAge) → register{value} flow on
// DotnsRegistrarController; setting records is owner-gated on the resolver.
// Kept as typed throwing entry points so the surface is complete and callers
// see a clear error rather than a missing export.

/** Build a registration transaction for a DotNS name. NOT wired yet. */
export function registerDotNs(_args: RegisterDotNsArgs, _opts: DotNsClientOptions): never {
    // TODO(dotns-abi): DotnsRegistrarController makeCommitment → commit → register.
    throw new DotNsError("NotWired", WRITES_NOT_WIRED);
}

/** Build a transaction that sets a DotNS name's resolved record. NOT wired yet. */
export function setDotNsRecord(_args: SetRecordArgs, _opts: DotNsClientOptions): never {
    // TODO(dotns-abi): DotnsResolver.setAddress(node, address), owner-gated.
    throw new DotNsError("NotWired", WRITES_NOT_WIRED);
}
