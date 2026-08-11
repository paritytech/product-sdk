// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * DotNS registry reads and writes.
 *
 * The DotNS registry is a Revive contract; reads are `dryRunCall`s and writes
 * are submittable transactions the caller signs via `@parity/product-sdk-tx`.
 * See `docs/product-sdk/dotns-registry-support.md` (sdk-team) for the design.
 *
 * **Implementation status.** The surface, validation, error model, and client
 * options are real. The on-chain contract calls are NOT wired yet: the deployed
 * registry contract's ABI (its resolve / reverse / register method names and
 * argument shapes) is unconfirmed — the `CDM_REGISTRY_ABI` in
 * `@parity/product-sdk-contracts` is a *contract-deployment* registry
 * (`getAddress`/`getAddressAtVersion`), NOT DotNS name resolution. Every call
 * below returns `err(DotNsError("NotWired", …))` until the ABI lands; the
 * `TODO(dotns-abi)` markers are the exact swap-in points.
 */
import { err, type Result } from "@parity/result";
import type { ContractRuntime } from "@parity/product-sdk-contracts";
import { createLogger } from "@parity/product-sdk-logger";
import { DotNsError } from "./dotns-errors.js";
import { isValidDotNsName, normalizeDotNsName } from "./dotns.js";
import type { DotNsRecord } from "./types.js";

const log = createLogger("identity:dotns");

type HexString = `0x${string}`;

/** Shared inputs for a DotNS registry call. */
export interface DotNsClientOptions {
    /**
     * A contract runtime for the chain hosting the DotNS registry. The read
     * path issues a `dryRunCall` against it; the write path builds calldata for
     * it. Reuse an existing runtime where possible.
     */
    runtime: ContractRuntime;
    /**
     * The registry contract address. When omitted, resolved from the product's
     * `cdm.json` `registry` field (once ABI wiring lands — see module note).
     */
    registryAddress?: HexString;
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

const NOT_WIRED =
    "DotNS registry calls are not wired to the on-chain contract yet " +
    "(the registry ABI is unconfirmed). See dotns-registry.ts / the design doc.";

/**
 * Resolve a DotNS name to its registry record.
 *
 * @returns `ok(record)`, `ok(null)` when the name is unregistered, or
 *   `err(DotNsError)` on invalid input / registry failure.
 */
export async function resolveDotNs(
    name: string,
    opts: DotNsClientOptions,
): Promise<Result<DotNsRecord | null, DotNsError>> {
    const normalized = normalizeDotNsName(name);
    if (!isValidDotNsName(normalized)) {
        return err(new DotNsError("InvalidName", `Invalid DotNS name: "${name}"`));
    }
    log.debug("resolveDotNs", { name: normalized, registry: opts.registryAddress });
    // TODO(dotns-abi): encode a resolve(name) call, dryRunCall via opts.runtime
    //   against the registry address, decode into DotNsRecord | null.
    return err(new DotNsError("NotWired", NOT_WIRED));
}

/**
 * Reverse-resolve an account to its primary DotNS name.
 *
 * @returns `ok(name)`, `ok(null)` when no primary name is set, or `err`.
 */
export async function reverseDotNs(
    address: string,
    opts: DotNsClientOptions,
): Promise<Result<string | null, DotNsError>> {
    log.debug("reverseDotNs", { address, registry: opts.registryAddress });
    // TODO(dotns-abi): encode a reverse(account) call, dryRunCall, decode to name | null.
    return err(new DotNsError("NotWired", NOT_WIRED));
}

/**
 * Whether a DotNS name is unregistered (available to claim).
 *
 * Thin convenience over {@link resolveDotNs}: `ok(true)` iff resolve returns
 * `ok(null)`. Registry failures propagate as `err`.
 */
export async function isDotNsAvailable(
    name: string,
    opts: DotNsClientOptions,
): Promise<Result<boolean, DotNsError>> {
    const resolved = await resolveDotNs(name, opts);
    if (!resolved.ok) return resolved;
    return { ok: true, value: resolved.value === null };
}

// ── Writes ───────────────────────────────────────────────────────────
//
// Writes return the calldata/submittable the caller signs + submits via
// @parity/product-sdk-tx. Left unimplemented pending the ABI; kept as typed
// throwing entry points so the surface is complete and callers see a clear
// error rather than a missing export.

/** Build a registration transaction for a DotNS name. */
export function registerDotNs(_args: RegisterDotNsArgs, _opts: DotNsClientOptions): never {
    // TODO(dotns-abi): encode register(name, owner) calldata; return a submittable.
    throw new DotNsError("NotWired", NOT_WIRED);
}

/** Build a transaction that sets a DotNS name's resolved record. */
export function setDotNsRecord(_args: SetRecordArgs, _opts: DotNsClientOptions): never {
    // TODO(dotns-abi): encode setRecord(name, address) calldata; return a submittable.
    throw new DotNsError("NotWired", NOT_WIRED);
}
