// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS registry reads and writes.
 *
 * DotNS is an ENS-style system on Asset Hub: a `DotnsRegistry` maps a node
 * (namehash) to a resolver + owner, a `DotnsResolver` maps a node to an
 * address, and a `DotnsReverseResolver` maps an account back to its name.
 *
 * **Names are rooted at the network's TLD, which is per deployment.** It is
 * fixed when `DotnsProtocolRegistry.initialize` runs, has no setter, and is
 * published as `tld()`. `.paseo` on Paseo Asset Hub Next V2, `.dot` on
 * Previewnet, and operators can choose others. Every entry point that hashes a
 * name therefore asks the chain first, through {@link resolveTld}, and callers
 * can supply `opts.tld` to skip the read. Hashing under the wrong root returns a
 * node the chain never wrote to, so the failure looks exactly like an
 * unregistered name — which is why nothing here assumes a root.
 *
 * A rule this module holds to throughout: **a failed read must never become a
 * plausible value.** The one deliberate exception is documented on
 * {@link resolveTld}, where a missing getter identifies a deployment whose TLD
 * could only have been `.dot`. All
 * are Revive contracts, reached via `@parity/product-sdk-contracts`'
 * `createContract(...).<method>.query(...)`. Contract source:
 * https://github.com/paritytech/dotns
 *
 * Reads (`resolveDotNs` / `reverseDotNs` / `isDotNsAvailable`) query chain.
 * Writes return prepared calls the caller submits with their own signer:
 * `setDotNsRecord` (the resolver pointer, when it needs moving, plus the
 * record) and `prepareDotNsRegistration` (the commit call plus a thunk for the
 * register call, which cannot be built until the commitment is on chain).
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
    DOTNS_PROTOCOL_REGISTRY_ABI,
    DOTNS_REGISTRAR_CONTROLLER_ABI,
    DOTNS_REGISTRY_ABI,
    DOTNS_RESOLVER_ABI,
    DOTNS_RESOLVER_WRITE_ABI,
    DOTNS_REVERSE_RESOLVER_ABI,
    DOTNS_ADDRESSES,
    POP_STATUS,
} from "./dotns-abis.js";
import { DotNsError } from "./dotns-errors.js";
import { isResolvableDotNsName, isValidDotNsName, normalizeDotNsName } from "./dotns.js";
import {
    DOT_TLD,
    dotNsTld,
    type DotNsTld,
    isConsistentDotNsTld,
    namehash,
    stripSuffix,
} from "./dotns-namehash.js";
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
    /** `DotnsRegistry` address. Defaults to the deployed set, which is the same on every network. */
    registryAddress?: HexString;
    /** `DotnsReverseResolver` address. Defaults to the deployed set. */
    reverseResolverAddress?: HexString;
    /** `DotnsResolver` address (writes: setDotNsRecord). Defaults to Paseo AH. */
    resolverAddress?: HexString;
    /** `DotnsRegistrarController` address (registration). Defaults to Paseo AH. */
    registrarControllerAddress?: HexString;
    /** `PopRules` address (registration price). Defaults to Paseo AH. */
    popRulesAddress?: HexString;
    /**
     * `DotnsProtocolRegistry` address, the contract holding this network's TLD.
     * Defaults to Paseo AH — and the address is the same on every network, since
     * the whole set is CREATE3-deterministic.
     */
    protocolRegistryAddress?: HexString;
    /**
     * The deployment's TLD, when you already know it.
     *
     * Omit it and the client reads `protocolRegistry.tld()` once per runtime and
     * caches it, which is the correct default: the TLD is per network and only
     * the chain knows which one is in play. Supply it to skip the read for
     * offline or test use, or to pin a deployment deliberately. Build it with
     * `dotNsTld(".paseo")` rather than by hand — a suffix paired with the wrong
     * node is rejected, because that pairing is the defect this option could
     * otherwise reintroduce.
     */
    tld?: DotNsTld;
}

/** Arguments for {@link prepareDotNsRegistration}. */
export interface RegisterDotNsArgs {
    /** The name to register, e.g. `"alice.paseo"` — or the bare label `"alice"`. */
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
    // createContract is generic over a typed ABI def; these minimal literal ABIs
    // are called by name via .query(), so the handle is untyped by construction.
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

// ── The deployment's TLD ─────────────────────────────────────────────
//
// Every node hash is rooted at the network's TLD, which is fixed when
// `DotnsProtocolRegistry.initialize` runs and has no setter. Read it once per
// (runtime, protocol registry) and cache it: it cannot change under us.

/**
 * Cached TLD per runtime, then per protocol-registry address.
 *
 * Keyed on the address as well as the runtime because the address is
 * overridable, and one runtime pointed at two registries has two TLDs. The
 * value is the in-flight promise rather than the resolved TLD, so concurrent
 * first calls share one read instead of racing.
 */
const tldCache = new WeakMap<ContractRuntime, Map<string, Promise<Result<DotNsTld, DotNsError>>>>();

/** An empty-payload revert: the contract ran and refused, telling us nothing. */
function isEmptyRevert(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as { type?: unknown }).type === "ContractRevertedWithPayload" &&
        (value as { data?: unknown }).data === "0x"
    );
}

/**
 * The TLD every name on this deployment is rooted at.
 *
 * Asks `protocolRegistry.tld()` and derives the node from the suffix, which is
 * exactly what `initialize` did — so `tldNode()` is only ever a cross-check, and
 * one read answers the question.
 *
 * Three outcomes, and the middle one is a deliberate exception to this module's
 * rule that a failed read must never become a plausible value:
 *
 *   - the getter answers with a usable suffix → that TLD;
 *   - the getter **reverts with an empty payload** → `DOT_TLD`, with a warning.
 *     That signature means the function does not exist, which dates the
 *     deployment before `dotns` `b4096968` ("make the TLD network-configurable
 *     via the protocol registry"). Before that commit the TLD was a
 *     compile-time constant and `.dot` was the only value it could hold, so
 *     this is the one case where the fallback is provably right rather than
 *     merely plausible. Verified against Paseo Asset Hub Previewnet, where both
 *     getters revert empty and `dim2` is owned under the `.dot` root;
 *   - anything else → `err`. A dispatch failure, a revert carrying a reason, an
 *     undecodable answer, or a TLD we cannot use.
 *
 * That last case includes a getter that *succeeds* with an unusable value. The
 * registry is `UUPSUpgradeable` with no reinitializer, so a pre-`b4096968` proxy
 * upgraded to current contracts without a migration reports `_tld` as `""` and
 * `_tldNode` as zero — both getters succeed and hand back the plain ENS root,
 * which would silently reroot every name. {@link isConsistentDotNsTld} is what
 * catches it.
 *
 * @internal Exposed for unit testing; consumers reach it through the entry points.
 */
export async function resolveTld(opts: DotNsClientOptions): Promise<Result<DotNsTld, DotNsError>> {
    if (opts.tld) {
        // A caller-supplied pair gets the same consistency check as a chain read:
        // `.paseo` carrying `DOT_NODE` is the original bug via the override path.
        return isConsistentDotNsTld(opts.tld)
            ? ok(opts.tld)
            : err(
                  new DotNsError(
                      "InvalidTld",
                      `opts.tld is inconsistent: "${opts.tld.suffix}" does not hash to ${opts.tld.node}`,
                  ),
              );
    }

    const address = (opts.protocolRegistryAddress ?? DOTNS_ADDRESSES.protocolRegistry) as HexString;
    let perAddress = tldCache.get(opts.runtime);
    if (!perAddress) {
        perAddress = new Map();
        tldCache.set(opts.runtime, perAddress);
    }
    const cached = perAddress.get(address);
    if (cached) return cached;

    const pending = readTld(opts, address);
    perAddress.set(address, pending);
    // Only a successful read is worth keeping: a failure is usually transient
    // (RPC, not deployment), and caching it would strand the client for the
    // life of the runtime.
    pending.then((result) => {
        if (!result.ok) perAddress?.delete(address);
    });
    return pending;
}

async function readTld(
    opts: DotNsClientOptions,
    address: HexString,
): Promise<Result<DotNsTld, DotNsError>> {
    try {
        const registry = contractOf(opts.runtime, address, DOTNS_PROTOCOL_REGISTRY_ABI);
        const origin = readOrigin(opts);
        const suffixRes = await registry.tld.query({ origin });

        if (!suffixRes.success) {
            if (isEmptyRevert(suffixRes.value)) {
                log.warn(
                    "DotNS protocol registry has no tld() getter; treating this as a " +
                        "pre-b4096968 deployment, whose TLD was the compile-time .dot",
                    { protocolRegistry: address },
                );
                return ok(DOT_TLD);
            }
            return err(
                new DotNsError("RegistryCall", "protocolRegistry.tld call failed", {
                    cause: suffixRes.value,
                }),
            );
        }

        const suffix = suffixRes.value as string;
        const tld = dotNsTld(suffix);
        if (!isConsistentDotNsTld(tld)) {
            return err(
                new DotNsError(
                    "InvalidTld",
                    `protocolRegistry.tld returned an unusable TLD: ${JSON.stringify(suffix)}`,
                ),
            );
        }

        // Cross-check, not the source. A disagreement means the deployment's
        // stored node was not derived from its stored label, which no
        // `initialize` can produce — so trust neither value.
        //
        // Only a well-formed node counts as a disagreement. A revert (the getter
        // is absent) or an unreadable answer means the cross-check did not run,
        // which is not evidence against a suffix that already derived cleanly.
        const nodeRes = await registry.tldNode.query({ origin });
        if (nodeRes.success && isNode(nodeRes.value) && !sameNode(nodeRes.value, tld.node)) {
            return err(
                new DotNsError(
                    "InvalidTld",
                    `protocolRegistry disagrees with itself: tld() ${suffix} derives ` +
                        `${tld.node} but tldNode() reports ${String(nodeRes.value)}`,
                ),
            );
        }

        log.debug("resolveTld", { protocolRegistry: address, suffix: tld.suffix, node: tld.node });
        return ok(tld);
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "DotNS TLD read failed", { cause }));
    }
}

/**
 * Why a normalized name was refused.
 *
 * Two distinct answers, because they call for different things from the caller.
 * `TldMismatch` means the name is well formed but belongs to another
 * deployment — `alice.dot` handed to a `.paseo` network — which a product may
 * want to offer to correct, and which the SDK must never correct silently:
 * the two are separate registrations that may have different owners.
 * `InvalidName` means the labels themselves are malformed, and no rewrite helps.
 */
function nameError(input: string, normalized: string, tld: DotNsTld): DotNsError {
    if (!normalized.endsWith(tld.suffix)) {
        return new DotNsError(
            "TldMismatch",
            `DotNS name "${input}" is not on this deployment, which uses "${tld.suffix}"`,
        );
    }
    return new DotNsError("InvalidName", `Invalid DotNS name: "${input}"`);
}

/** Whether a value is a readable 32-byte node, and so usable as a cross-check. */
function isNode(value: unknown): value is HexString {
    return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Case-insensitive 32-byte node compare, for the same reason as {@link sameAddress}. */
function sameNode(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
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
    // The TLD comes first because normalization and validation both need the
    // suffix. One read per runtime, cached; an invalid name therefore costs a
    // chain read on the first call and none after. Do not move validation back
    // in front of this — it cannot know what a valid name looks like yet.
    const tldRes = await resolveTld(opts);
    if (!tldRes.ok) return tldRes;
    const tld = tldRes.value;
    const normalized = normalizeDotNsName(name, tld.suffix);
    if (!isResolvableDotNsName(normalized, tld.suffix)) {
        return err(nameError(name, normalized, tld));
    }
    const node = namehash(normalized, tld);
    const registryAddr = opts.registryAddress ?? DOTNS_ADDRESSES.registry;
    const reverseAddr = opts.reverseResolverAddress ?? DOTNS_ADDRESSES.reverseResolver;
    const origin = readOrigin(opts);
    log.debug("resolveDotNs", { name: normalized, node, registry: registryAddr });

    try {
        const registry = contractOf(opts.runtime, registryAddr as HexString, DOTNS_REGISTRY_ABI);

        const [ownerRes, resolverRes] = await Promise.all([
            registry.owner.query(node, { origin }),
            registry.resolver.query(node, { origin }),
        ]);
        if (!ownerRes.success) {
            return err(
                new DotNsError("RegistryCall", "registry.owner call failed", {
                    cause: ownerRes.value,
                }),
            );
        }
        if (!resolverRes.success) {
            return err(
                new DotNsError("RegistryCall", "registry.resolver call failed", {
                    cause: resolverRes.value,
                }),
            );
        }

        // Existence check: the getter falls back to the registrar's ERC-721
        // holder, and returns zero for a node with no record.
        const owner = ownerRes.value as HexString;
        if (isZero(owner)) return ok(null);

        // Registration parks the pointer on the reverse resolver, which has no
        // `addressOf`, so both cases mean "no forward record" rather than "call it".
        const resolverAddr = resolverRes.value as HexString;
        if (isZero(resolverAddr) || sameAddress(resolverAddr, reverseAddr)) {
            return ok({ name: normalized, owner });
        }

        const resolver = contractOf(opts.runtime, resolverAddr as HexString, DOTNS_RESOLVER_ABI);
        const addrRes = await resolver.addressOf.query(node, { origin });
        if (!addrRes.success) {
            return err(
                new DotNsError("RegistryCall", "resolver.addressOf call failed", {
                    cause: addrRes.value,
                }),
            );
        }
        const address = addrRes.value as HexString;
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
    const reverseAddr = opts.reverseResolverAddress ?? DOTNS_ADDRESSES.reverseResolver;
    log.debug("reverseDotNs", { address, reverseResolver: reverseAddr });
    try {
        const reverse = contractOf(
            opts.runtime,
            reverseAddr as HexString,
            DOTNS_REVERSE_RESOLVER_ABI,
        );
        const res = await reverse.nameOf.query(address, { origin: readOrigin(opts) });
        if (!res.success) {
            return err(
                new DotNsError("RegistryCall", "reverseResolver.nameOf call failed", {
                    cause: res.value,
                }),
            );
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
 * Two reads, because "not minted" and "claimable" are different questions:
 *
 *   - `registrarController.available(label)`, the predicate `register` enforces
 *     through `_requireAvailableLabel`. Deliberately not inferred from
 *     resolution: a registered name has no forward record until its owner sets
 *     one, so that would report owned names as free.
 *   - `PopRules.classifyName(label)`, which is pure and owner-independent.
 *     Labels of 5 base characters or fewer are reserved for governance and can
 *     never be claimed, though the registrar still reports them as unminted.
 *
 * `ok(true)` means the name can be registered by someone. It does not mean the
 * caller can register it: labels of 6 to 8 characters additionally require a
 * personhood tier, which depends on the owner and is checked by
 * {@link prepareDotNsRegistration}.
 *
 * Validated first because both reads revert on labels we already reject.
 */
export async function isDotNsAvailable(
    name: string,
    opts: DotNsClientOptions,
): Promise<Result<boolean, DotNsError>> {
    const tldRes = await resolveTld(opts);
    if (!tldRes.ok) return tldRes;
    const tld = tldRes.value;
    const normalized = normalizeDotNsName(name, tld.suffix);
    if (!isValidDotNsName(normalized, tld.suffix)) {
        return err(nameError(name, normalized, tld));
    }
    // The registrar takes the bare label, without the TLD suffix.
    const label = stripSuffix(normalized, tld.suffix);
    const controllerAddr = opts.registrarControllerAddress ?? DOTNS_ADDRESSES.registrarController;
    log.debug("isDotNsAvailable", { name: normalized, label, controller: controllerAddr });

    try {
        const controller = contractOf(
            opts.runtime,
            controllerAddr as HexString,
            DOTNS_REGISTRAR_CONTROLLER_ABI,
        );
        const popRules = contractOf(
            opts.runtime,
            (opts.popRulesAddress ?? DOTNS_ADDRESSES.popRules) as HexString,
            DOTNS_POP_RULES_ABI,
        );
        const origin = readOrigin(opts);
        const [res, classified] = await Promise.all([
            controller.available.query(label, { origin }),
            popRules.classifyName.query(label, { origin }),
        ]);
        if (!res.success) {
            return err(
                new DotNsError("RegistryCall", "registrarController.available call failed", {
                    cause: res.value,
                }),
            );
        }
        if (res.value !== true) return ok(false);

        // classifyName reverts on a label shape the registrar rejects, so a
        // failure here is surfaced rather than folded into `false`.
        if (!classified.success) {
            return err(
                new DotNsError("RegistryCall", "PopRules.classifyName call failed", {
                    cause: classified.value,
                }),
            );
        }
        const { requirement } = classified.value as { requirement: number; message: string };
        return ok(requirement !== POP_STATUS.Reserved);
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
    const tldRes = await resolveTld(opts);
    if (!tldRes.ok) return tldRes;
    const tld = tldRes.value;
    const normalized = normalizeDotNsName(args.name, tld.suffix);
    if (!isResolvableDotNsName(normalized, tld.suffix)) {
        return err(nameError(args.name, normalized, tld));
    }
    // Both calls are owner-gated, so a dry-run from the fallback account would
    // revert and the error would look like a contract problem.
    const origin = opts.origin;
    if (!origin) {
        return err(new DotNsError("MissingOrigin", "setDotNsRecord needs opts.origin (SS58)"));
    }
    const node = namehash(normalized, tld);
    const registryAddr = opts.registryAddress ?? DOTNS_ADDRESSES.registry;
    const resolverAddr = opts.resolverAddress ?? DOTNS_ADDRESSES.resolver;
    try {
        const registry = contractOf(opts.runtime, registryAddr as HexString, DOTNS_REGISTRY_ABI);
        const currentRes = await registry.resolver.query(node, { origin });
        if (!currentRes.success) {
            return err(
                new DotNsError("RegistryCall", "registry.resolver call failed", {
                    cause: currentRes.value,
                }),
            );
        }

        const calls: BatchableCall[] = [];
        if (!sameAddress(currentRes.value, resolverAddr)) {
            const pointer = await registry.setResolver.prepare(node, resolverAddr, { origin });
            if (!pointer.ok) {
                return err(
                    new DotNsError("RegistryCall", "registry.setResolver prepare failed", {
                        cause: pointer.error,
                    }),
                );
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
            return err(
                new DotNsError("RegistryCall", "resolver.setAddress prepare failed", {
                    cause: prepared.error,
                }),
            );
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
        return err(
            new DotNsError("RegistryCall", "PopRules.priceWithoutCheck failed", {
                cause: quote.value,
            }),
        );
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
        return err(
            new DotNsError("RegistryCall", "PopRules.transferFloor failed", {
                cause: floor.value,
            }),
        );
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
    const tldRes = await resolveTld(opts);
    if (!tldRes.ok) return tldRes;
    const tld = tldRes.value;
    const normalized = normalizeDotNsName(args.name, tld.suffix);
    if (!isValidDotNsName(normalized, tld.suffix)) {
        return err(nameError(args.name, normalized, tld));
    }
    const origin = opts.origin;
    if (!origin) {
        return err(
            new DotNsError("MissingOrigin", "prepareDotNsRegistration needs opts.origin (SS58)"),
        );
    }
    // The registrar takes the bare label, without the TLD suffix.
    const label = stripSuffix(normalized, tld.suffix);
    const controllerAddr = opts.registrarControllerAddress ?? DOTNS_ADDRESSES.registrarController;
    const popRulesAddr = opts.popRulesAddress ?? DOTNS_ADDRESSES.popRules;
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

        const [commitmentRes, availableRes, quote, minRes, maxRes] = await Promise.all([
            controller.makeCommitment.query(registration, { origin }),
            controller.available.query(label, { origin }),
            quoteRegistration(popRules, label, args.owner, payer, origin),
            controller.minCommitmentAge.query({ origin }),
            controller.maxCommitmentAge.query({ origin }),
        ]);
        // `register` runs _requireAvailableLabel before anything else, so a
        // taken name costs the caller a commit fee and then reverts.
        if (!availableRes.success) {
            return err(
                new DotNsError("RegistryCall", "registrarController.available call failed", {
                    cause: availableRes.value,
                }),
            );
        }
        if (availableRes.value !== true) {
            return err(new DotNsError("NameUnavailable", `"${label}" is already registered`));
        }
        if (!commitmentRes.success) {
            return err(
                new DotNsError("RegistryCall", "makeCommitment failed", {
                    cause: commitmentRes.value,
                }),
            );
        }
        if (!quote.ok) return quote;
        if (!minRes.success || !maxRes.success) {
            return err(
                new DotNsError("RegistryCall", "commitment window read failed", {
                    cause: minRes.success ? maxRes.value : minRes.value,
                }),
            );
        }
        const commitment = commitmentRes.value as HexString;

        const commitPrep = await controller.commit.prepare(commitment, { origin });
        if (!commitPrep.ok) {
            return err(
                new DotNsError("RegistryCall", "controller.commit prepare failed", {
                    cause: commitPrep.error,
                }),
            );
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
                        new DotNsError("RegistryCall", "controller.register prepare failed", {
                            cause: prep.error,
                        }),
                    );
                }
                return ok(prep.value as BatchableCall);
            },
        });
    } catch (cause) {
        return err(new DotNsError("RegistryCall", "DotNS registration prepare failed", { cause }));
    }
}
