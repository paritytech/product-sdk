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
 * Reads (`resolveDotNs` / `reverseDotNs` / `isDotNsAvailable`) query chain.
 * Writes return prepared calls the caller submits with their own signer:
 * `setDotNsRecord` (one `setAddress` call) and `prepareDotNsRegistration` (the
 * commit + register calls plus the timing window — registration is a two-tx
 * commit-reveal-and-pay flow, so it can't be a single call).
 *
 * Note: this deployment has no name-expiry concept (the registrar exposes no
 * expiry getter), so `DotNsRecord.expiresAt` is always omitted.
 */
import { err, ok, type Result } from "@parity/result";
import { type AbiEntry, type BatchableCall, createContract } from "@parity/product-sdk-contracts";
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { bytesToHex, randomBytes } from "@parity/product-sdk-crypto";
import { createLogger } from "@parity/product-sdk-logger";
import {
    DOTNS_POP_RULES_ABI,
    DOTNS_REGISTRAR_CONTROLLER_ABI,
    DOTNS_REGISTRY_ABI,
    DOTNS_RESOLVER_ABI,
    DOTNS_RESOLVER_WRITE_ABI,
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
    /** `DotnsResolver` address (writes: setDotNsRecord). Defaults to Paseo AH. */
    resolverAddress?: HexString;
    /** `DotnsRegistrarController` address (registration). Defaults to Paseo AH. */
    registrarControllerAddress?: HexString;
    /** `PopRules` address (registration price). Defaults to Paseo AH. */
    popRulesAddress?: HexString;
}

/** Arguments for {@link prepareDotNsRegistration}. */
export interface RegisterDotNsArgs {
    /** The name to register, e.g. `"alice.dot"` (or bare `"alice"`). */
    name: string;
    /** The account that will own the registered name. */
    owner: string;
    /** Reserved-name registration (default `false`). */
    reserved?: boolean;
}

/** Arguments for {@link setDotNsRecord}. */
export interface SetRecordArgs {
    /** The name whose resolver record is being set. */
    name: string;
    /** The address the name should resolve to. */
    address: string;
}

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

// ── Writes ───────────────────────────────────────────────────────────
//
// Writes return prepared calls (`BatchableCall`) the caller submits with their
// own signer via `@parity/product-sdk-tx` — the surface stays signer-free, like
// the reads. Registration is a two-transaction commit-reveal, so it can't be a
// single call; `prepareDotNsRegistration` returns both plus the timing window.

/**
 * Prepare a `setAddress` call binding a name to a resolved address. The caller
 * must own the node; submit the returned call with the owner's signer.
 */
export async function setDotNsRecord(
    args: SetRecordArgs,
    opts: DotNsClientOptions,
): Promise<Result<BatchableCall, DotNsError>> {
    const normalized = normalizeDotNsName(args.name);
    if (!isValidDotNsName(normalized)) {
        return err(new DotNsError("InvalidName", `Invalid DotNS name: "${args.name}"`));
    }
    const node = namehash(normalized);
    const resolverAddr = opts.resolverAddress ?? PASEO_ASSETHUB_DOTNS.resolver;
    try {
        const resolver = contractOf(
            opts.runtime,
            resolverAddr as HexString,
            DOTNS_RESOLVER_WRITE_ABI,
        );
        const prepared = await resolver.setAddress.prepare(node, args.address);
        if (!prepared.ok) {
            return err(new DotNsError("RegistryCall", "resolver.setAddress prepare failed"));
        }
        return ok(prepared.value as BatchableCall);
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "DotNS setRecord failed", { cause }));
    }
}

/** The prepared pieces of a DotNS registration. */
export interface DotNsRegistration {
    /** The random secret bound into both commit and register — reuse verbatim. */
    secret: HexString;
    /** The commitment hash (also encoded inside `commitCall`). */
    commitment: HexString;
    /** Submit first, with the owner's signer. */
    commitCall: BatchableCall;
    /** Submit after `minCommitmentAge` (and before `maxCommitmentAge`) elapses. */
    registerCall: BatchableCall;
    /** Seconds to wait after `commit` before `register` is accepted. */
    minCommitmentAge: bigint;
    /** Seconds after which the commitment expires and `register` is rejected. */
    maxCommitmentAge: bigint;
    /** The registration price (the `register` call's payable value). */
    price: bigint;
}

/**
 * Prepare a DotNS registration: the commit + register calls, the shared secret,
 * and the timing window. Registration is commit-reveal —
 *
 *   1. submit `commitCall`
 *   2. wait `minCommitmentAge` (register before `maxCommitmentAge`)
 *   3. submit `registerCall` (its payable value is already set to `price`)
 *
 * The `register` price comes from `PopRules.price(label)`.
 */
export async function prepareDotNsRegistration(
    args: RegisterDotNsArgs,
    opts: DotNsClientOptions,
): Promise<Result<DotNsRegistration, DotNsError>> {
    const normalized = normalizeDotNsName(args.name);
    if (!isValidDotNsName(normalized)) {
        return err(new DotNsError("InvalidName", `Invalid DotNS name: "${args.name}"`));
    }
    // The registrar takes the bare label (no ".dot" suffix).
    const label = normalized.slice(0, -4);
    const controllerAddr =
        opts.registrarControllerAddress ?? PASEO_ASSETHUB_DOTNS.registrarController;
    const popRulesAddr = opts.popRulesAddress ?? PASEO_ASSETHUB_DOTNS.popRules;
    const secret = `0x${bytesToHex(randomBytes(32))}` as HexString;
    const registration = { label, owner: args.owner, secret, reserved: args.reserved ?? false };

    try {
        const controller = contractOf(
            opts.runtime,
            controllerAddr as HexString,
            DOTNS_REGISTRAR_CONTROLLER_ABI,
        );
        const popRules = contractOf(opts.runtime, popRulesAddr as HexString, DOTNS_POP_RULES_ABI);

        const [commitmentRes, priceRes, minRes, maxRes] = await Promise.all([
            controller.makeCommitment.query(registration),
            popRules.price.query(label),
            controller.minCommitmentAge.query(),
            controller.maxCommitmentAge.query(),
        ]);
        if (!commitmentRes.success) {
            return err(new DotNsError("RegistryCall", "makeCommitment failed"));
        }
        if (!priceRes.success) {
            return err(new DotNsError("RegistryCall", "PopRules.price failed"));
        }
        const commitment = commitmentRes.value as HexString;
        const price = BigInt(priceRes.value as string | number | bigint);

        const [commitPrep, registerPrep] = await Promise.all([
            controller.commit.prepare(commitment),
            controller.register.prepare(registration, { value: price }),
        ]);
        if (!commitPrep.ok || !registerPrep.ok) {
            return err(new DotNsError("RegistryCall", "commit / register prepare failed"));
        }

        return ok({
            secret,
            commitment,
            commitCall: commitPrep.value as BatchableCall,
            registerCall: registerPrep.value as BatchableCall,
            minCommitmentAge: BigInt(minRes.success ? (minRes.value as string | number) : 0),
            maxCommitmentAge: BigInt(maxRes.success ? (maxRes.value as string | number) : 0),
            price,
        });
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "DotNS registration prepare failed", { cause }));
    }
}
