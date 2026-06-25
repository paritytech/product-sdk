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

import { scale } from "@parity/truapi";
import type {
    AllocatableResource as TruAllocatableResource,
    AllocationOutcome as TruAllocationOutcome,
    GenericError,
    HexString,
    RemotePermission as TruRemotePermission,
    TrUApiClient,
} from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import { getClient, subscribeWithInterrupt } from "./transport.js";
import type { HostSubscription, Statement, StatementProof } from "./types.js";

const log = createLogger("host");

/**
 * The error shapes `@parity/truapi` surfaces on the `Err` channel of a host
 * call, once unwrapped from the versioned wire envelope. Every host error union
 * is built from these:
 *
 * - the catch-all {@link GenericError} (`{ reason }`),
 * - a unit tagged variant (`{ tag }`), or
 * - a tagged variant carrying a reason (`{ tag, value: { reason } }`).
 *
 * `GenericError` is imported from `@parity/truapi`; the `{ tag }` members are a
 * deliberate widening of truapi's per-domain named variants (the formatter is
 * tag-agnostic). truapi has no umbrella error union to import today — once it
 * exports a canonical `HostError` / tagged-error union from codegen, replace
 * these local members with that import so the type is protocol-sourced rather
 * than hand-widened.
 */
export type HostError =
    | GenericError
    | { tag: string; value?: undefined }
    | { tag: string; value: { reason: string } };

/** Narrow an unknown `Err`-channel value to a {@link HostError}. */
function isHostError(error: unknown): error is HostError {
    if (error == null || typeof error !== "object") return false;
    const obj = error as Record<string, unknown>;
    return typeof obj.reason === "string" || typeof obj.tag === "string";
}

/**
 * Extract a human-readable message from a host-side error.
 *
 * Renders the {@link HostError} shapes `@parity/truapi` surfaces. Accepts
 * `unknown` because it is also the catch-all formatter for the wrappers'
 * `throw new Error(...)` messages, so it falls back to `Error`/string/JSON
 * rendering for anything that isn't a recognized host error.
 *
 * Exported for the higher-level wrappers (`requestPermission`,
 * `deriveEntropy`, etc.) that build their `throw new Error(...)` messages.
 */
export function formatHostError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;

    if (isHostError(error)) {
        if ("tag" in error) {
            // Tagged variant carrying a reason: { tag, value: { reason } }
            if (error.value != null && typeof error.value.reason === "string") {
                return `${error.tag}: ${error.value.reason}`;
            }
            // Unit tagged variant, e.g. { tag: "Full" } / { tag: "PermissionDenied" }
            return error.tag;
        }
        // GenericError: { reason }
        return error.reason;
    }

    if (error != null && typeof error === "object" && "message" in error) {
        const message = (error as { message: unknown }).message;
        if (typeof message === "string") return message;
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
// Hex helpers
// ─────────────────────────────────────────────────────────────────────────────

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

    test("formatHostError renders the TruAPI error shapes", () => {
        // GenericError: { reason }
        expect(formatHostError({ reason: "boom" })).toBe("boom");
        // Tagged variant carrying a reason: { tag, value: { reason } }
        expect(formatHostError({ tag: "Unknown", value: { reason: "boom" } })).toBe(
            "Unknown: boom",
        );
        // Unit tagged variant: { tag }
        expect(formatHostError({ tag: "Full" })).toBe("Full");
        // Catch-all fallbacks for non-host-error input
        expect(formatHostError(new Error("plain"))).toBe("plain");
        expect(formatHostError("string err")).toBe("string err");
        expect(formatHostError({ message: "loose" })).toBe("loose");
    });

    test("hex helpers", () => {
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
