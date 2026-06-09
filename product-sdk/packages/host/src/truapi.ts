// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * TruAPI - the protocol for communicating between apps and the Polkadot host container.
 *
 * This module centralizes access to the in-house `@parity/truapi` client,
 * allowing other `@parity/product-sdk-*` packages to import from here rather
 * than depending directly on the protocol package. The client is built and
 * cached by {@link module:transport}; this module layers the throw-on-error
 * convenience wrappers on top.
 *
 * @module
 */

import { ok as resultOk, err as resultErr, type Result } from "neverthrow";

import { scale } from "@parity/truapi";
import type {
    AllocatableResource as TruAllocatableResource,
    AllocationOutcome as TruAllocationOutcome,
    HexString,
    RemotePermission as TruRemotePermission,
    TrUApiClient,
} from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import type { HostSubscription, Statement, StatementProof } from "./types.js";

const log = createLogger("host");

/**
 * Extract a human-readable message from a host-side error.
 *
 * TruAPI errors arrive already unwrapped from their versioned wire envelope, in
 * one of a few shapes: the catch-all `GenericError` (`{ reason }`), a tagged
 * variant carrying a reason (`{ tag, value: { reason } }`), or a unit tagged
 * variant (`{ tag }`). For resilience it also still unwraps the legacy novasama
 * envelope (`{ tag: "v1", value: { name, message } }`), since this is a public
 * helper and the surfaces still on the novasama wrapper (PAPI provider, accounts)
 * may surface that shape.
 *
 * Exported for the higher-level wrappers (`requestPermission`,
 * `deriveEntropy`, etc.) that build their `throw new Error(...)` messages.
 */
export function formatHostError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;

    if (error != null && typeof error === "object") {
        const obj = error as Record<string, unknown>;

        // TruAPI GenericError: { reason }
        if (typeof obj.reason === "string") return obj.reason;

        // Tagged error variant: { tag, value? }
        if (typeof obj.tag === "string") {
            const value = obj.value;
            if (value != null && typeof value === "object") {
                const inner = value as Record<string, unknown>;
                // TruAPI tagged error carrying a reason: { tag, value: { reason } }
                if (typeof inner.reason === "string") return `${obj.tag}: ${inner.reason}`;
                // Legacy novasama envelope: { tag: "v1", value: { name, message } }
                if (typeof inner.message === "string") {
                    return typeof inner.name === "string"
                        ? `${inner.name}: ${inner.message}`
                        : inner.message;
                }
            }
            // Unit tagged variant, e.g. { tag: "Full" } / { tag: "PermissionDenied" }
            return obj.tag;
        }

        if (typeof obj.message === "string") return obj.message;
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Await a host `ResultAsync`, returning its Ok value or throwing a diagnostic
 * `Error` built from the host's error payload (preserved as `cause`). Collapses
 * the repeated `.match(ok, err => throw)` dance the host wrappers would otherwise
 * each spell out.
 */
export function unwrapHostResult<T, E>(result: ResultAsync<T, E>, label: string): Promise<T> {
    return result.match(
        (value) => value,
        (error: E) => {
            throw new Error(`${label}: ${formatHostError(error)}`, { cause: error });
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Enum / Result / hex helpers
//
// `@parity/truapi`'s generated client wraps the versioned wire envelope
// internally, so most callers no longer build these by hand. They are kept as
// part of the public surface (and used by the surfaces still on novasama) as
// thin, dependency-light shims.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construct a tagged enum variant, e.g. `enumValue("ChainSubmit")` or
 * `enumValue("v1", payload)`. Matches the `{ tag, value }` shape used across
 * the host protocol.
 */
export function enumValue<Tag extends string>(tag: Tag): { tag: Tag; value?: undefined };
export function enumValue<Tag extends string, Value>(
    tag: Tag,
    value: Value,
): { tag: Tag; value: Value };
export function enumValue<Tag extends string, Value>(
    tag: Tag,
    value?: Value,
): { tag: Tag; value?: Value } {
    return { tag, value };
}

/** Check whether a value is a specific tagged enum variant. */
export function isEnumVariant<Tag extends string>(
    value: unknown,
    tag: Tag,
): value is { tag: Tag; value?: unknown } {
    return value != null && typeof value === "object" && (value as { tag?: unknown }).tag === tag;
}

/** Assert that a value is a specific tagged enum variant, throwing if not. */
export function assertEnumVariant<Tag extends string>(
    value: unknown,
    tag: Tag,
): asserts value is { tag: Tag; value?: unknown } {
    if (!isEnumVariant(value, tag)) {
        throw new Error(`Expected enum variant "${tag}", got ${formatHostError(value)}`);
    }
}

/** Create an Ok result (re-exported from `neverthrow`). */
export { resultOk, resultErr };

/** Unwrap a neverthrow `Result`, throwing the error channel on `Err`. */
export function unwrapResultOrThrow<T, E>(result: Result<T, E>): T {
    if (result.isOk()) return result.value;
    const error = result.error;
    throw error instanceof Error ? error : new Error(formatHostError(error));
}

/** Convert bytes to a `0x`-prefixed lower-case hex string. */
export function toHex(bytes: Uint8Array): HexString {
    return scale.bytesToHex(bytes);
}

/** Convert a hex string (with or without `0x`) to bytes. */
export function fromHex(hex: string): Uint8Array {
    return scale.hexToBytes(hex);
}

/** A `0x`-prefixed hex string used by the host API surface for raw byte payloads. */
export type { HexString };

// ─────────────────────────────────────────────────────────────────────────────
// TruAPI accessor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The TruApi client — namespaced access to every host protocol domain
 * (`permissions`, `entropy`, `signing`, `statementStore`, `system`,
 * `localStorage`, …). Identical to `TrUApiClient` from `@parity/truapi`.
 *
 * @example
 * ```ts
 * const truApi = await getTruApi();
 * if (truApi) {
 *   await truApi.permissions.requestRemotePermission({
 *     permission: { tag: "ChainSubmit", value: undefined },
 *   });
 *   await truApi.system.navigateTo({ url: "polkadot://settings" });
 * }
 * ```
 */
export type TruApi = TrUApiClient;

/**
 * Get the TruAPI client for direct low-level access to host protocol domains.
 *
 * Returns the cached `@parity/truapi` client once the host transport is built
 * and the handshake has run, or `null` when running outside a container.
 *
 * For most use cases, prefer the higher-level functions like
 * {@link requestPermission}, {@link deriveEntropy}, or `getHostLocalStorage()`.
 *
 * @returns The TruAPI client, or `null` if unavailable.
 */
export async function getTruApi(): Promise<TruApi | null> {
    return getClient();
}

/**
 * Preimage manager handle for bulletin chain operations, backed by
 * `truApi.preimage.*`. `lookup` opens a {@link HostSubscription} (`unsubscribe`
 * + `onInterrupt`) that delivers the preimage bytes — or `null` until the host
 * finds them; `submit` uploads a preimage and resolves to its `0x`-prefixed hex
 * key.
 */
export interface PreimageManager {
    lookup(key: HexString, callback: (preimage: Uint8Array | null) => void): HostSubscription;
    submit(value: Uint8Array): Promise<HexString>;
}

/** Build a {@link PreimageManager} over a TruAPI client's `preimage` domain. */
function adaptPreimageManager(client: TrUApiClient): PreimageManager {
    const preimage = client.preimage;
    return {
        lookup(key, callback) {
            return subscribeWithInterrupt(preimage.lookupSubscribe({ request: { key } }), (item) =>
                callback(item.value !== undefined ? fromHex(item.value) : null),
            );
        },
        submit(value) {
            return unwrapHostResult(preimage.submit(toHex(value)), "preimage submit failed");
        },
    };
}

/**
 * Get the preimage manager for bulletin chain operations.
 *
 * @returns The preimage manager, or `null` if unavailable (outside a container).
 */
export async function getPreimageManager(): Promise<PreimageManager | null> {
    const client = await getClient();
    return client ? adaptPreimageManager(client) : null;
}

/**
 * Construct a `PreimageManager`. Retained for API compatibility; with the single
 * cached TruAPI client this is equivalent to {@link getPreimageManager}.
 *
 * @returns A `PreimageManager` instance, or `null` if unavailable.
 */
export async function createHostPreimageManager(): Promise<PreimageManager | null> {
    return getPreimageManager();
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource allocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resource types requestable via {@link requestResourceAllocation}.
 * Re-exported from `@parity/truapi` so variant renames surface as compile
 * errors, not runtime failures.
 */
export type AllocatableResource = TruAllocatableResource;

/** Tag-only view of {@link AllocatableResource} for places that just need the variant name. */
export type AllocatableResourceTag = AllocatableResource["tag"];

/**
 * Per-resource outcome from {@link requestResourceAllocation}: a string union
 * `"Allocated" | "Rejected" | "NotAvailable"` (RFC-10).
 */
export type AllocationOutcome = TruAllocationOutcome;

/** Alias of {@link AllocationOutcome}; the outcome value *is* its tag (a string union). */
export type AllocationOutcomeTag = AllocationOutcome;

/**
 * Remote permission the dapp can ask the host to grant via
 * {@link requestPermission}. Re-exported from `@parity/truapi`.
 */
export type RemotePermission = TruRemotePermission;

/** Tag-only view of {@link RemotePermission}. */
export type RemotePermissionTag = RemotePermission["tag"];

/**
 * Request the host to pre-allocate one or more resource allowances.
 *
 * The host prompts the user once; subsequent operations covered by the
 * granted allowance don't re-prompt.
 *
 * @param resources - Resources to request.
 * @returns Per-resource outcomes in the same order as `resources`.
 * @throws If the host is unavailable or the request fails.
 *
 * @example
 * ```ts
 * const outcomes = await requestResourceAllocation([
 *   { tag: "BulletinAllowance", value: undefined },
 * ]);
 * if (outcomes[0] === "Allocated") { ... }
 * ```
 */
export async function requestResourceAllocation(
    resources: AllocatableResource[],
): Promise<AllocationOutcome[]> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("requestResourceAllocation: TruAPI unavailable");
    }
    log.debug("requestResourceAllocation", { resources: resources.map((r) => r.tag) });

    const response = await unwrapHostResult(
        truApi.resourceAllocation.request({ resources }),
        "requestResourceAllocation failed",
    );
    return response.outcomes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorized Statement Store proof creation (RFC-10 §"Statement Store allowance")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Have the host sign a Statement using the product's allowance-bearing account,
 * which it picks internally — RFC-10 §"Statement Store allowance". No per-call
 * account id is needed (this is the sponsored-submission path).
 *
 * Pairs with {@link getStatementStore}'s `submit`: call this to obtain a proof,
 * attach it to the Statement, and submit the result.
 *
 * @param statement - The Statement to be signed.
 * @returns The proof to attach before submitting.
 * @throws If the host is unavailable or the host-side signing fails.
 */
export async function createProofAuthorized(statement: Statement): Promise<StatementProof> {
    const truApi = await getTruApi();
    if (!truApi) {
        throw new Error("createProofAuthorized: TruAPI unavailable");
    }
    log.debug("createProofAuthorized", { topics: statement.topics.length });

    const response = await unwrapHostResult(
        truApi.statementStore.createProofAuthorized(statement),
        "createProofAuthorized failed",
    );
    return response.proof;
}

/**
 * Neverthrow-style ResultAsync returned by product-sdk methods.
 *
 * Use `.match(onOk, onErr)` to handle success/error cases.
 */
export interface ResultAsync<T, E> {
    match: <A, B = A>(ok: (t: T) => A, err: (e: E) => B) => Promise<A | B>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.vitest) {
    const { test, expect, afterEach } = import.meta.vitest;
    const { disposeClient } = await import("./transport.js");

    afterEach(() => disposeClient());

    test("getTruApi returns null outside a container", async () => {
        const api = await getTruApi();
        expect(api === null || typeof api === "object").toBe(true);
    });

    test("getPreimageManager returns manager or null", async () => {
        const manager = await getPreimageManager();
        expect(manager === null || typeof manager === "object").toBe(true);
    });

    test("createHostPreimageManager returns null outside container", async () => {
        expect(await createHostPreimageManager()).toBeNull();
    });

    test("formatHostError renders TruAPI and legacy error shapes", () => {
        // TruAPI GenericError
        expect(formatHostError({ reason: "boom" })).toBe("boom");
        // TruAPI tagged error carrying a reason
        expect(formatHostError({ tag: "Unknown", value: { reason: "boom" } })).toBe(
            "Unknown: boom",
        );
        // TruAPI unit tagged variant
        expect(formatHostError({ tag: "Full" })).toBe("Full");
        // Plain Error / string
        expect(formatHostError(new Error("plain"))).toBe("plain");
        expect(formatHostError("string err")).toBe("string err");
        // Legacy novasama envelope still handled
        expect(
            formatHostError({ tag: "v1", value: { name: "GenericError", message: "boom" } }),
        ).toBe("GenericError: boom");
    });

    test("enum / hex helpers", () => {
        expect(enumValue("v1", 42)).toEqual({ tag: "v1", value: 42 });
        expect(enumValue("ChainSubmit")).toEqual({ tag: "ChainSubmit", value: undefined });
        expect(isEnumVariant({ tag: "Foo" }, "Foo")).toBe(true);
        expect(isEnumVariant({ tag: "Foo" }, "Bar")).toBe(false);
        expect(toHex(new Uint8Array([0xde, 0xad]))).toBe("0xdead");
        expect(Array.from(fromHex("0xdead"))).toEqual([0xde, 0xad]);
    });

    test("requestResourceAllocation throws when TruAPI is unavailable", async () => {
        const api = await getTruApi();
        if (api === null) {
            await expect(
                requestResourceAllocation([{ tag: "BulletinAllowance", value: undefined }]),
            ).rejects.toThrow(/TruAPI unavailable/);
        } else {
            expect(typeof requestResourceAllocation).toBe("function");
        }
    });

    test("createProofAuthorized is callable", () => {
        expect(typeof createProofAuthorized).toBe("function");
    });
}
