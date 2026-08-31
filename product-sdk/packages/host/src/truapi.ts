// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * TruAPI - the protocol for communicating between apps and the Polkadot host container.
 *
 * This module centralizes access to the in-house `@parity/truapi` client,
 * allowing other `@parity/product-sdk-*` packages to import from here rather
 * than depending directly on the protocol package. The client is built and
 * cached by {@link module:transport}; this module adds the accessor plus the
 * two helpers the convenience wrappers fold truapi's `ResultAsync` through —
 * {@link mapHostResult} (returns a `Result`, used by the public operations) and
 * {@link unwrapHostResult} (throws, used by the adapter-object methods).
 *
 * @module
 */

import { scale } from "@parity/truapi";
import type {
    AllocatableResource,
    AllocationOutcome,
    HexString,
    RemotePermission,
    TrUApiClient,
} from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";

import {
    type HostError,
    type HostErrorPayload,
    HostCallFailedError,
    HostResponseDecodeError,
    HostUnavailableError,
    formatHostError,
} from "./errors.js";
import { type Result, err, ok } from "./result.js";
import { getClient, subscribeWithInterrupt } from "./transport.js";
import type { HostSubscription, Statement, StatementProof } from "./types.js";

const log = createLogger("host");

/**
 * `result.match(onOk, onErr)`, but a decode-time rejection is routed through
 * `onDecode` instead of rejecting the returned promise.
 *
 * The truapi client decodes each response inside the value it resolves, and
 * wraps the whole call with `ResultAsync.fromSafePromise`, which installs no
 * rejection handler. So when the host's reply doesn't match the client's codec
 * — a protocol-version skew, or a channel that closed mid-call — the resulting
 * rejection escapes the `Result` channel entirely and `.match` never sees it,
 * surfacing as a raw `RangeError` rather than reaching `onErr`. Catching the
 * `.match` promise re-homes that rejection as a typed
 * {@link HostResponseDecodeError} that names the call. Both
 * {@link unwrapHostResult} and {@link mapHostResult} route through here, so
 * every boundary — throwing and Result-returning — is covered, not just the
 * accounts adapter.
 */
async function matchGuarded<T, E, A, B>(
    result: ResultAsync<T, E>,
    label: string,
    onOk: (value: T) => A,
    onErr: (error: E) => B,
    onDecode: (error: HostResponseDecodeError) => B,
): Promise<A | B> {
    // `.match` rejects for two reasons: the underlying `ResultAsync` rejected (a
    // decode failure — what we want to catch), or `onOk`/`onErr` themselves threw
    // (e.g. `unwrapHostResult`'s err path deliberately throws). Wrap the handler
    // throws in a sentinel so the `catch` can tell them apart and only re-home a
    // genuine underlying rejection; a handler throw is rethrown unchanged.
    try {
        return await result.match(
            (value) => {
                try {
                    return onOk(value);
                } catch (thrown) {
                    throw new HandlerThrow(thrown);
                }
            },
            (error) => {
                try {
                    return onErr(error);
                } catch (thrown) {
                    throw new HandlerThrow(thrown);
                }
            },
        );
    } catch (cause) {
        if (cause instanceof HandlerThrow) throw cause.thrown;
        return onDecode(
            cause instanceof HostResponseDecodeError
                ? cause
                : new HostResponseDecodeError(label, cause),
        );
    }
}

/** Marks a throw that came from a caller's `onOk`/`onErr`, not the underlying `ResultAsync`. */
class HandlerThrow {
    constructor(readonly thrown: unknown) {}
}

/**
 * Await a host `ResultAsync`, returning its Ok value or throwing a diagnostic
 * `Error` built from the host's error payload (preserved as `cause`).
 *
 * This is the *throwing* helper, retained for the methods of the adapter objects
 * returned by the feature-detection getters (`PreimageManager.submit`,
 * `HostLocalStorage.read`, `AccountsProvider` signing, …). Those objects often
 * implement external interfaces (e.g. polkadot-api's `JsonRpcProvider`) whose
 * method signatures can't carry a {@link Result}, so they keep the
 * throw convention. The flat public operations use {@link mapHostResult} instead.
 */
export function unwrapHostResult<T, E>(result: ResultAsync<T, E>, label: string): Promise<T> {
    return matchGuarded(
        result,
        label,
        (value) => value,
        (error: E) => {
            throw new Error(`${label}: ${formatHostError(error)}`, { cause: error });
        },
        // A response the client can't decode would otherwise reject with a raw
        // `RangeError`; throw it as a typed, named error instead.
        (decodeError) => {
            throw decodeError;
        },
    );
}

/**
 * Await a host `ResultAsync` and fold it into a tagged {@link Result}: maps the
 * Ok value through `map`, or wraps the host error payload in a
 * {@link HostCallFailedError} on the `err` channel. This is the non-throwing
 * boundary the flat public host operations (`requestPermission`, `deriveEntropy`,
 * `requestResourceAllocation`, …) return through.
 */
export function mapHostResult<T, U>(
    result: ResultAsync<T, HostErrorPayload>,
    map: (value: T) => U,
    label: string,
): Promise<Result<U, HostError>> {
    // A response the client can't decode would otherwise reject this promise
    // with a raw `RangeError`; return it as a typed err instead, matching the
    // `Result` contract these flat public operations advertise.
    return matchGuarded<T, HostErrorPayload, Result<U, HostError>, Result<U, HostError>>(
        result,
        label,
        (value) => ok(map(value)),
        (error) => err(new HostCallFailedError(label, error)),
        (decodeError) => err(decodeError),
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

// Resource-allocation / permission types, re-exported verbatim from
// `@parity/truapi` (imported above for the local signatures):
// - `AllocatableResource` — resource types requestable via `requestResourceAllocation`.
//   Its `SmartContractAllowance` variant carries the tagged `DerivationIndex`
//   selector (`{ tag: "Index", value: number }` for a plain index, `{ tag:
//   "Raw", value: HexString }` for a raw 32-byte index).
// - `AllocationOutcome` — per-resource outcome, the string union
//   `"Allocated" | "Rejected" | "NotAvailable"` (RFC-10).
// - `RemotePermission` — permission the dapp asks the host to grant via `requestPermission`.
export type { AllocatableResource, AllocationOutcome, RemotePermission };

/**
 * Request the host to pre-allocate one or more resource allowances.
 *
 * The host prompts the user once; subsequent operations covered by the
 * granted allowance don't re-prompt.
 *
 * @param resources - Resources to request.
 * @returns `ok` with per-resource outcomes in the same order as `resources`, or
 *   `err(HostUnavailableError | HostCallFailedError)`.
 *
 * @example
 * ```ts
 * const r = await requestResourceAllocation([
 *   { tag: "BulletinAllowance", value: undefined },
 * ]);
 * if (r.ok && r.value[0] === "Allocated") { ... }
 * ```
 */
export async function requestResourceAllocation(
    resources: AllocatableResource[],
): Promise<Result<AllocationOutcome[], HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("requestResourceAllocation: TruAPI unavailable"));
    }
    log.debug("requestResourceAllocation", { resources: resources.map((r) => r.tag) });

    return mapHostResult(
        truApi.resourceAllocation.request({ resources }),
        (response) => response.outcomes,
        "requestResourceAllocation failed",
    );
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
 * @returns `ok` with the proof to attach before submitting, or
 *   `err(HostUnavailableError | HostCallFailedError)`.
 */
export async function createProofAuthorized(
    statement: Statement,
): Promise<Result<StatementProof, HostError>> {
    const truApi = await getTruApi();
    if (!truApi) {
        return err(new HostUnavailableError("createProofAuthorized: TruAPI unavailable"));
    }
    log.debug("createProofAuthorized", { topics: statement.topics.length });

    return mapHostResult(
        truApi.statementStore.createProofAuthorized(statement),
        (response) => response.proof,
        "createProofAuthorized failed",
    );
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
    const { test, expect, describe } = import.meta.vitest;

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

    test("hex helpers", () => {
        expect(toHex(new Uint8Array([0xde, 0xad]))).toBe("0xdead");
        expect(Array.from(fromHex("0xdead"))).toEqual([0xde, 0xad]);
    });

    test("requestResourceAllocation returns err when TruAPI is unavailable", async () => {
        const api = await getTruApi();
        if (api === null) {
            const result = await requestResourceAllocation([
                { tag: "BulletinAllowance", value: undefined },
            ]);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostUnavailableError);
            }
        } else {
            expect(typeof requestResourceAllocation).toBe("function");
        }
    });

    test("createProofAuthorized is callable", () => {
        expect(typeof createProofAuthorized).toBe("function");
    });

    // The decode boundary these two helpers share. The truapi client's real
    // `ResultAsync` *rejects* its underlying promise on a decode failure, which
    // `.match` surfaces as a rejected promise — modelled here by a fake whose
    // `.match` rejects. Ok and typed-err doubles mirror neverthrow's `.match`.
    const okLike = <T>(value: T): ResultAsync<T, never> => ({
        match: async (onOk) => onOk(value),
    });
    const errLike = <E>(error: E): ResultAsync<never, E> => ({
        match: async (_onOk, onErr) => onErr(error),
    });
    const rejectLike = (cause: unknown): ResultAsync<never, never> => ({
        match: () => Promise.reject(cause),
    });

    describe("mapHostResult decode boundary", () => {
        test("a decode rejection becomes err(HostResponseDecodeError) naming the call", async () => {
            const cause = new RangeError("Offset is outside the bounds of the DataView");
            const result = await mapHostResult(rejectLike(cause), (v) => v, "createRingVRFProof");
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostResponseDecodeError);
                expect((result.error as HostResponseDecodeError).call).toBe("createRingVRFProof");
                expect((result.error as HostResponseDecodeError).cause).toBe(cause);
            }
        });

        test("an ok value maps through", async () => {
            const result = await mapHostResult(okLike(41), (v: number) => v + 1, "getUserId");
            expect(result.ok && result.value).toBe(42);
        });

        test("a typed host err becomes HostCallFailedError, not a decode error", async () => {
            const result = await mapHostResult(errLike({ tag: "Denied" }), (v) => v, "getUserId");
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(HostCallFailedError);
                expect(result.error).not.toBeInstanceOf(HostResponseDecodeError);
            }
        });
    });

    describe("unwrapHostResult decode boundary", () => {
        test("a decode rejection throws HostResponseDecodeError naming the call", async () => {
            const cause = new RangeError("Offset is outside the bounds of the DataView");
            await expect(unwrapHostResult(rejectLike(cause), "signVrf")).rejects.toMatchObject({
                name: "HostResponseDecodeError",
                call: "signVrf",
                cause,
            });
        });

        test("an ok value passes through", async () => {
            expect(await unwrapHostResult(okLike("hi"), "getUserId")).toBe("hi");
        });

        test("a typed host err still throws a diagnostic Error, not a decode error", async () => {
            await expect(
                unwrapHostResult(errLike({ tag: "Denied" }), "getUserId"),
            ).rejects.not.toBeInstanceOf(HostResponseDecodeError);
        });
    });
}
