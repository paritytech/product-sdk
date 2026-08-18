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
import {
    type AbiEntry,
    type BatchableCall,
    createContract,
    QUERY_FALLBACK_ORIGIN,
} from "@parity/product-sdk-contracts";
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { bytesToHex, randomBytes } from "@parity/product-sdk-crypto";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { createLogger } from "@parity/product-sdk-logger";
import type { SS58String } from "polkadot-api";
import {
    DOTNS_POP_RULES_ABI,
    DOTNS_REGISTRAR_CONTROLLER_ABI,
    DOTNS_REGISTRY_ABI,
    DOTNS_RESOLVER_ABI,
    DOTNS_RESOLVER_WRITE_ABI,
    DOTNS_REVERSE_RESOLVER_ABI,
    PASEO_ASSETHUB_DOTNS,
    POP_STATUS,
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
    /**
     * SS58 account that will submit the prepared calls.
     *
     * Required by the write helpers, which dry-run against it: `setAddress` and
     * `setResolver` are owner-gated, so a dry-run from anyone else reverts.
     * Optional for reads, which fall back to the pallet-revive query account.
     *
     * Must be SS58, not the account's H160. pallet-revive derives `msg.sender`
     * from it; convert with `h160ToSs58` from `@parity/product-sdk-address`.
     */
    origin?: SS58String;
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
 * Origin for a read. Passing the fallback explicitly rather than letting the
 * contracts layer substitute it keeps each query from logging a warning.
 */
function readOrigin(opts: DotNsClientOptions): SS58String {
    return opts.origin ?? QUERY_FALLBACK_ORIGIN;
}

/** Case-insensitive H160 compare: chain reads are lowercase, our table is EIP-55. */
function sameAddress(a: unknown, b: unknown): boolean {
    return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolve a DotNS name. `expiresAt` is omitted (no on-chain expiry here).
 *
 * Three outcomes, because the registry's resolver pointer is configuration, not
 * proof of existence:
 *
 *   - `ok(null)` — unregistered (`registry.owner` is zero).
 *   - `ok({ name, owner })` — registered, no forward record yet.
 *   - `ok({ name, owner, address })` — resolves.
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
    const reverseAddr = opts.reverseResolverAddress ?? PASEO_ASSETHUB_DOTNS.reverseResolver;
    const origin = readOrigin(opts);
    log.debug("resolveDotNs", { name: normalized, node, registry: registryAddr });

    try {
        const registry = contractOf(opts.runtime, registryAddr as HexString, DOTNS_REGISTRY_ABI);

        const [ownerRes, resolverRes] = await Promise.all([
            registry.owner.query(node, { origin }),
            registry.resolver.query(node, { origin }),
        ]);
        if (!ownerRes.success) {
            return err(new DotNsError("RegistryCall", "registry.owner call failed"));
        }
        if (!resolverRes.success) {
            return err(new DotNsError("RegistryCall", "registry.resolver call failed"));
        }

        // Existence check: the getter falls back to the registrar's ERC-721
        // holder, and returns zero for a node with no record.
        const owner = ownerRes.value as string;
        if (isZero(owner)) return ok(null);

        // Registration parks the pointer on the reverse resolver, which has no
        // `addressOf`, so both cases mean "no forward record" rather than "call it".
        const resolverAddr = resolverRes.value as string;
        if (isZero(resolverAddr) || sameAddress(resolverAddr, reverseAddr)) {
            return ok({ name: normalized, owner });
        }

        const resolver = contractOf(opts.runtime, resolverAddr as HexString, DOTNS_RESOLVER_ABI);
        const addrRes = await resolver.addressOf.query(node, { origin });
        if (!addrRes.success) {
            return err(new DotNsError("RegistryCall", "resolver.addressOf call failed"));
        }
        const address = addrRes.value as string;
        // A forward resolver holding an empty record is still no forward record.
        if (isZero(address)) return ok({ name: normalized, owner });

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
        const res = await reverse.nameOf.query(address, { origin: readOrigin(opts) });
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
 * Whether a DotNS name is available to claim.
 *
 * Asks `registrarController.available(label)`, the predicate `register` itself
 * enforces. Deliberately not inferred from resolution: a registered name has no
 * forward record until its owner sets one, so that would report owned names as
 * free. Validated first because `available` reverts on labels we already reject.
 */
export async function isDotNsAvailable(
    name: string,
    opts: DotNsClientOptions,
): Promise<Result<boolean, DotNsError>> {
    const normalized = normalizeDotNsName(name);
    if (!isValidDotNsName(normalized)) {
        return err(new DotNsError("InvalidName", `Invalid DotNS name: "${name}"`));
    }
    // The registrar takes the bare label (no ".dot" suffix).
    const label = normalized.slice(0, -4);
    const controllerAddr =
        opts.registrarControllerAddress ?? PASEO_ASSETHUB_DOTNS.registrarController;
    log.debug("isDotNsAvailable", { name: normalized, label, controller: controllerAddr });

    try {
        const controller = contractOf(
            opts.runtime,
            controllerAddr as HexString,
            DOTNS_REGISTRAR_CONTROLLER_ABI,
        );
        const res = await controller.available.query(label, { origin: readOrigin(opts) });
        if (!res.success) {
            return err(new DotNsError("RegistryCall", "registrarController.available call failed"));
        }
        return ok(res.value as boolean);
    } catch (cause) {
        return err(
            new DotNsError("RegistryCall", `DotNS availability check failed for "${normalized}"`, {
                cause,
            }),
        );
    }
}

// ── Writes ───────────────────────────────────────────────────────────
//
// Writes return prepared calls (`BatchableCall`) the caller submits with their
// own signer via `@parity/product-sdk-tx` — the surface stays signer-free, like
// the reads. Registration is a two-transaction commit-reveal, so it can't be a
// single call; `prepareDotNsRegistration` returns both plus the timing window.

/**
 * Prepare the calls binding a name to an address. Submit them in order with the
 * owner's signer via `batchSubmitAndWatch`; both are owner-gated.
 *
 * Returns two calls when the node still points at the reverse resolver (the
 * post-registration default): `registry.setResolver` first, or the record
 * written by `setAddress` is real but unreadable. One call once it is pointed.
 */
export async function setDotNsRecord(
    args: SetRecordArgs,
    opts: DotNsClientOptions,
): Promise<Result<BatchableCall[], DotNsError>> {
    const normalized = normalizeDotNsName(args.name);
    if (!isValidDotNsName(normalized)) {
        return err(new DotNsError("InvalidName", `Invalid DotNS name: "${args.name}"`));
    }
    // Both calls are owner-gated, so a dry-run from the fallback account would
    // revert and the error would look like a contract problem.
    const origin = opts.origin;
    if (!origin) {
        return err(new DotNsError("MissingOrigin", "setDotNsRecord needs opts.origin (SS58)"));
    }
    const node = namehash(normalized);
    const registryAddr = opts.registryAddress ?? PASEO_ASSETHUB_DOTNS.registry;
    const resolverAddr = opts.resolverAddress ?? PASEO_ASSETHUB_DOTNS.resolver;
    try {
        const registry = contractOf(opts.runtime, registryAddr as HexString, DOTNS_REGISTRY_ABI);
        const currentRes = await registry.resolver.query(node, { origin });
        if (!currentRes.success) {
            return err(new DotNsError("RegistryCall", "registry.resolver call failed"));
        }

        const calls: BatchableCall[] = [];
        if (!sameAddress(currentRes.value, resolverAddr)) {
            const pointer = await registry.setResolver.prepare(node, resolverAddr, { origin });
            if (!pointer.ok) {
                return err(new DotNsError("RegistryCall", "registry.setResolver prepare failed"));
            }
            calls.push(pointer.value as BatchableCall);
        }

        const resolver = contractOf(
            opts.runtime,
            resolverAddr as HexString,
            DOTNS_RESOLVER_WRITE_ABI,
        );
        const prepared = await resolver.setAddress.prepare(node, args.address, { origin });
        if (!prepared.ok) {
            return err(new DotNsError("RegistryCall", "resolver.setAddress prepare failed"));
        }
        calls.push(prepared.value as BatchableCall);

        return ok(calls);
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "DotNS setRecord failed", { cause }));
    }
}

/** The prepared pieces of a DotNS registration. */
export interface DotNsRegistration {
    /** The random secret bound into both commit and register. */
    secret: HexString;
    /** The commitment hash (also encoded inside `commitCall`). */
    commitment: HexString;
    /** Submit first, with the owner's signer. */
    commitCall: BatchableCall;
    /** Seconds to wait after `commit` before `register` is accepted. */
    minCommitmentAge: bigint;
    /** Seconds after which the commitment expires and `register` is rejected. */
    maxCommitmentAge: bigint;
    /** Quote at prepare time, for display. The submitted value is re-read below. */
    price: bigint;
    /**
     * Build the register call, once `minCommitmentAge` has elapsed.
     *
     * Deferred rather than returned up front: `register` consumes the
     * commitment, so dry-running it before `commitCall` lands reverts with
     * `CommitmentNotFound` and no call could be built at all. Deferring also
     * prices and sizes it against the state it will actually execute in.
     */
    prepareRegisterCall: () => Promise<Result<BatchableCall, DotNsError>>;
}

/** What `register` will charge, and whether it will accept the owner at all. */
async function quoteRegistration(
    popRules: ReturnType<typeof contractOf>,
    label: string,
    owner: string,
    payer: string,
    origin: SS58String,
): Promise<Result<bigint, DotNsError>> {
    // `price(label)` is not what register charges: it skips every eligibility
    // rule and ignores the owner. The owner-aware variant reports the same
    // classification register applies, without reverting on it.
    const quote = await popRules.priceWithoutCheck.query(label, owner, { origin });
    if (!quote.success) {
        return err(new DotNsError("RegistryCall", "PopRules.priceWithoutCheck failed"));
    }
    const { price, status, userStatus, message } = quote.value as {
        price: bigint;
        status: number;
        userStatus: number;
        message: string;
    };
    if (status === POP_STATUS.Reserved) {
        return err(new DotNsError("NameReserved", `"${label}" is reserved: ${message}`));
    }
    if (userStatus < status) {
        return err(
            new DotNsError(
                "OwnerStatusInsufficient",
                `"${label}" requires personhood tier ${status}, owner has ${userStatus}: ${message}`,
            ),
        );
    }

    // Cross-payer registrations add a friction floor; register charges the
    // larger of the two.
    if (sameAddress(payer, owner)) return ok(BigInt(price));
    const floor = await popRules.transferFloor.query(label, payer, owner, { origin });
    if (!floor.success) {
        return err(new DotNsError("RegistryCall", "PopRules.transferFloor failed"));
    }
    const friction = BigInt(floor.value as string | number | bigint);
    const base = BigInt(price);
    return ok(base > friction ? base : friction);
}

/**
 * Prepare a DotNS registration: the commit call, the shared secret, the timing
 * window, and a thunk that builds the register call afterwards.
 *
 *   1. submit `commitCall`
 *   2. wait `minCommitmentAge`, and register before `maxCommitmentAge`
 *   3. `await prepareRegisterCall()`, then submit what it returns
 *
 * Eligibility is checked here, before the caller pays for the commit: a
 * governance-reserved label, or an owner below the tier the label requires,
 * fails now rather than on the second transaction.
 */
export async function prepareDotNsRegistration(
    args: RegisterDotNsArgs,
    opts: DotNsClientOptions,
): Promise<Result<DotNsRegistration, DotNsError>> {
    const normalized = normalizeDotNsName(args.name);
    if (!isValidDotNsName(normalized)) {
        return err(new DotNsError("InvalidName", `Invalid DotNS name: "${args.name}"`));
    }
    const origin = opts.origin;
    if (!origin) {
        return err(
            new DotNsError("MissingOrigin", "prepareDotNsRegistration needs opts.origin (SS58)"),
        );
    }
    // The registrar takes the bare label (no ".dot" suffix).
    const label = normalized.slice(0, -4);
    const controllerAddr =
        opts.registrarControllerAddress ?? PASEO_ASSETHUB_DOTNS.registrarController;
    const popRulesAddr = opts.popRulesAddress ?? PASEO_ASSETHUB_DOTNS.popRules;
    const secret = `0x${bytesToHex(randomBytes(32))}` as HexString;
    const registration = { label, owner: args.owner, secret, reserved: args.reserved ?? false };
    // register compares msg.sender against the owner; msg.sender is derived
    // from the SS58 origin, so derive it the same way to predict the branch.
    const payer = ss58ToH160(origin);

    try {
        const controller = contractOf(
            opts.runtime,
            controllerAddr as HexString,
            DOTNS_REGISTRAR_CONTROLLER_ABI,
        );
        const popRules = contractOf(opts.runtime, popRulesAddr as HexString, DOTNS_POP_RULES_ABI);

        const [commitmentRes, quote, minRes, maxRes] = await Promise.all([
            controller.makeCommitment.query(registration, { origin }),
            quoteRegistration(popRules, label, args.owner, payer, origin),
            controller.minCommitmentAge.query({ origin }),
            controller.maxCommitmentAge.query({ origin }),
        ]);
        if (!commitmentRes.success) {
            return err(new DotNsError("RegistryCall", "makeCommitment failed"));
        }
        if (!quote.ok) return quote;
        if (!minRes.success || !maxRes.success) {
            return err(new DotNsError("RegistryCall", "commitment window read failed"));
        }
        const commitment = commitmentRes.value as HexString;

        const commitPrep = await controller.commit.prepare(commitment, { origin });
        if (!commitPrep.ok) {
            return err(new DotNsError("RegistryCall", "controller.commit prepare failed"));
        }

        return ok({
            secret,
            commitment,
            commitCall: commitPrep.value as BatchableCall,
            minCommitmentAge: BigInt(minRes.value as string | number),
            maxCommitmentAge: BigInt(maxRes.value as string | number),
            price: quote.value,
            prepareRegisterCall: async () => {
                // Re-quoted, not reused: the price and the owner's tier can both
                // move during the mandatory wait.
                const current = await quoteRegistration(popRules, label, args.owner, payer, origin);
                if (!current.ok) return current;
                const prep = await controller.register.prepare(registration, {
                    value: current.value,
                    origin,
                });
                if (!prep.ok) {
                    return err(
                        new DotNsError("RegistryCall", "controller.register prepare failed"),
                    );
                }
                return ok(prep.value as BatchableCall);
            },
        });
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "DotNS registration prepare failed", { cause }));
    }
}
