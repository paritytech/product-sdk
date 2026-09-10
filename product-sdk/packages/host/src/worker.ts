// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wrapper for calling this product's own background worker from its rendered
 * surface (App, Widget, or Funding).
 *
 * A product ships two things: the web application the host renders, and a
 * single background worker published at `worker.<product_id>.<tld>`. They run
 * in different sandboxes and cannot reach each other directly. This module is
 * the host-mediated path between them.
 *
 * **What crosses is data, never code.** `call(apiName, payload)` names an
 * export the worker archive already declared; the host resolves it against the
 * pinned, verified bundle. A page cannot hand the worker a function, a script,
 * or an import path — that would let anything able to inject into the page
 * (an XSS, a compromised dependency) run with worker authority, which is
 * strictly wider than the page's own.
 *
 * **The page never names the product.** The host supplies the product identity
 * from the surface it is rendering, so this call can only ever reach *your*
 * worker.
 *
 * **Opt in on chain, not here.** The host only routes this call when the worker
 * manifest declares the surface in `includes`. A worker published without it
 * answers `unavailable`, exactly as a host with no worker support would.
 *
 * ```ts
 * const worker = getWorkerManager();
 * const { jobId } = await worker.call<{ jobId: string }>("startSettlement", {
 *     rail: "BANK",
 *     intentId,
 * });
 * ```
 *
 * @module
 */

import { HostError, HostUnavailableError } from "./errors.js";

/**
 * Why a worker call did not produce a result — the frozen error set the host
 * runtime reports, surfaced verbatim so callers can branch rather than parse
 * a message.
 *
 * - `unavailable` — no worker registered, the user disabled it, the manifest
 *   declares no ceiling for this surface, or the worker is in crash
 *   quarantine. This is the one worth handling: it is the normal answer on a
 *   host that does not run workers at all.
 * - `denied` — the call passed the ceiling but failed a downstream
 *   authorization check.
 * - `invalid` — the worker exports no such name, or the payload is malformed
 *   or over the host's size bound.
 * - `timeout` — the call outlived its deadline and was revoked.
 * - `crashed` — the worker threw or died handling the call.
 * - `version` — the worker and host disagree on the protocol.
 */
export type WorkerErrorTag =
    | "unavailable"
    | "denied"
    | "invalid"
    | "timeout"
    | "crashed"
    | "version";

/**
 * A worker call that reached the host and came back without a result. Branch
 * on {@link WorkerCallError.tag}; `unavailable` is the expected answer when the
 * product ships no worker or the user has switched it off, so treat it as a
 * capability check rather than a fault.
 */
export class WorkerCallError extends HostError {
    /** Which of the frozen failure modes this was. */
    readonly tag: WorkerErrorTag;

    constructor(tag: WorkerErrorTag, reason?: string) {
        super(reason ? `worker call failed: ${tag} (${reason})` : `worker call failed: ${tag}`);
        this.name = "WorkerCallError";
        this.tag = tag;
    }
}

/**
 * Handle for this product's background worker. Obtain one with
 * {@link getWorkerManager}.
 */
export interface WorkerManager {
    /**
     * Whether the host exposes the worker bridge at all. `false` outside a host
     * container, and on hosts that predate the bridge. A `true` here does not
     * promise the product *has* a worker — that surfaces as an `unavailable`
     * {@link WorkerCallError} on the first call.
     */
    isAvailable(): boolean;

    /**
     * Invoke an export the worker archive declared.
     *
     * @param apiName - Export name, as published in the worker bundle.
     * @param payload - JSON-serialisable arguments. Bounded by the host's
     *   payload ceiling; keep it to identifiers and parameters, not blobs.
     * @param options - `deadlineMs` overrides the host default and is clamped
     *   to the host's own window.
     * @throws {@link WorkerCallError} for every typed failure, and
     *   {@link HostUnavailableError} when there is no host bridge at all.
     */
    call<Result = unknown>(
        apiName: string,
        payload?: unknown,
        options?: { deadlineMs?: number },
    ): Promise<Result>;
}

/**
 * The bridge the host installs on the page, mirroring the shape already used
 * by the Pocket capability bridge so one transport serves both.
 */
type WorkerBridge = (apiName: string, payloadJson: string, deadlineMs?: number) => Promise<string>;

const ERROR_TAGS: readonly WorkerErrorTag[] = [
    "unavailable",
    "denied",
    "invalid",
    "timeout",
    "crashed",
    "version",
];

function readBridge(): WorkerBridge | null {
    const host = (globalThis as { __polkadotHost?: { workerCall?: unknown } }).__polkadotHost;
    const bridge = host?.workerCall;
    return typeof bridge === "function" ? (bridge as WorkerBridge) : null;
}

function isErrorTag(value: unknown): value is WorkerErrorTag {
    return typeof value === "string" && (ERROR_TAGS as readonly string[]).includes(value);
}

/**
 * Turn the bridge's JSON answer into a result or a typed error.
 *
 * An unrecognised `error` value is reported as `unavailable` rather than
 * thrown away: a host that grows a new failure mode should degrade the same
 * way as a host with no worker support, not crash the page.
 */
function parseAnswer<Result>(raw: string): Result {
    let answer: unknown;
    try {
        answer = JSON.parse(raw);
    } catch {
        throw new WorkerCallError("invalid", "host answer was not JSON");
    }
    if (answer && typeof answer === "object" && "error" in answer) {
        const { error, reason } = answer as { error: unknown; reason?: unknown };
        throw new WorkerCallError(
            isErrorTag(error) ? error : "unavailable",
            typeof reason === "string" ? reason : undefined,
        );
    }
    return answer as Result;
}

/**
 * Get the handle for this product's background worker.
 *
 * Follows the singleton accessor pattern used by `getNotificationManager` and
 * `getPaymentManager`: cheap to call repeatedly, no setup, resolves the bridge
 * lazily so a page that never talks to its worker pays nothing.
 */
export function getWorkerManager(): WorkerManager {
    return {
        isAvailable() {
            return readBridge() !== null;
        },
        async call<Result = unknown>(
            apiName: string,
            payload?: unknown,
            options?: { deadlineMs?: number },
        ): Promise<Result> {
            const bridge = readBridge();
            if (!bridge) {
                throw new HostUnavailableError("no host worker bridge on this page");
            }
            const raw = await bridge(apiName, JSON.stringify(payload ?? {}), options?.deadlineMs);
            return parseAnswer<Result>(raw);
        },
    };
}

if (import.meta.vitest) {
    const { test, expect, afterEach } = import.meta.vitest;

    type Bridged = typeof globalThis & { __polkadotHost?: { workerCall?: unknown } };

    const install = (workerCall: unknown) => {
        (globalThis as Bridged).__polkadotHost = { workerCall };
    };

    afterEach(() => {
        (globalThis as Bridged).__polkadotHost = undefined;
    });

    test("reports unavailable when the host installs no bridge", () => {
        expect(getWorkerManager().isAvailable()).toBe(false);
    });

    test("calling without a bridge throws HostUnavailableError", async () => {
        await expect(getWorkerManager().call("startSettlement")).rejects.toBeInstanceOf(
            HostUnavailableError,
        );
    });

    test("passes the api name and a JSON payload to the bridge", async () => {
        const seen: unknown[] = [];
        install((apiName: string, payloadJson: string, deadlineMs?: number) => {
            seen.push([apiName, payloadJson, deadlineMs]);
            return Promise.resolve('{"jobId":"j-1"}');
        });
        const result = await getWorkerManager().call<{ jobId: string }>(
            "startSettlement",
            { rail: "BANK" },
            { deadlineMs: 5_000 },
        );
        expect(result).toEqual({ jobId: "j-1" });
        expect(seen).toEqual([["startSettlement", '{"rail":"BANK"}', 5_000]]);
    });

    test("an omitted payload is sent as an empty object, not undefined", async () => {
        let sent: string | undefined;
        install((_apiName: string, payloadJson: string) => {
            sent = payloadJson;
            return Promise.resolve("null");
        });
        await getWorkerManager().call("status");
        expect(sent).toBe("{}");
    });

    test("a typed host error surfaces as a WorkerCallError carrying the tag", async () => {
        install(() => Promise.resolve('{"error":"unavailable"}'));
        const error = await getWorkerManager()
            .call("startSettlement")
            .catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(WorkerCallError);
        expect((error as WorkerCallError).tag).toBe("unavailable");
    });

    test("an unrecognised error tag degrades to unavailable", async () => {
        install(() => Promise.resolve('{"error":"someFutureFailure"}'));
        const error = await getWorkerManager()
            .call("startSettlement")
            .catch((thrown: unknown) => thrown);
        expect((error as WorkerCallError).tag).toBe("unavailable");
    });

    test("a non-JSON answer is invalid rather than a parse crash", async () => {
        install(() => Promise.resolve("not json"));
        const error = await getWorkerManager()
            .call("status")
            .catch((thrown: unknown) => thrown);
        expect((error as WorkerCallError).tag).toBe("invalid");
    });
}
