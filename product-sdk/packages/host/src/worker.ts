// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Keeping a product worker running while it finishes work.
 *
 * The host runs a worker only while something holds it (a room on screen, a
 * query, a wake) and may stop it at any other time. Work that must not be cut
 * off, such as messages being sent, runs inside a host operation, which holds
 * the worker until it ends. The operating system may still end it on a phone.
 *
 * @module
 */
import type { TrUApiClient } from "@parity/truapi";
import { createLogger } from "@parity/product-sdk-logger";
import { type Clock, systemClock } from "@parity/product-sdk-utils";

import { formatHostError } from "./errors.js";
import { getClient } from "./transport.js";

const log = createLogger("host:worker");

/** How long an operation stays open after its last work, so retries a second apart reuse it. */
export const OPERATION_GRACE_MS = 3_000;

/**
 * One host operation shared by overlapping work. The first `around` begins it, and
 * it ends {@link OPERATION_GRACE_MS} after the last work finishes. A host without
 * operations, or one that refuses, leaves the work running unheld.
 */
export class OperationHold {
    private active = 0;
    private operation: Promise<number | undefined> | undefined;
    private generation = 0;

    /**
     * @param client - The host client.
     * @param label - Shown by hosts that list operations.
     * @param clock - Times the grace period; tests pass a `ManualClock`.
     */
    constructor(
        private readonly client: TrUApiClient,
        private readonly label: string,
        private readonly clock: Clock = systemClock,
    ) {}

    /** Runs `work` while the operation is held, and returns what it returns. */
    async around<T>(work: () => Promise<T>): Promise<T> {
        this.active++;
        this.generation++;
        this.operation ??= this.begin();
        try {
            return await work();
        } finally {
            this.active--;
            const generation = this.generation;
            void this.clock.sleep(OPERATION_GRACE_MS).then(() => {
                if (this.active === 0 && generation === this.generation) void this.end();
            });
        }
    }

    private async begin(): Promise<number | undefined> {
        const worker = this.client.worker as Partial<TrUApiClient["worker"]> | undefined;
        if (typeof worker?.beginOperation !== "function") return undefined;
        const result = await worker.beginOperation({ label: this.label });
        if (result.isErr()) {
            log.warn(`beginOperation failed: ${formatHostError(result.error)}`);
            return undefined;
        }
        return result.value.id;
    }

    private async end(): Promise<void> {
        const operation = this.operation;
        this.operation = undefined;
        const id = await operation;
        if (id === undefined) return;
        const result = await this.client.worker.endOperation({ id });
        if (result.isErr()) log.warn(`endOperation failed: ${formatHostError(result.error)}`);
    }
}

/**
 * An {@link OperationHold} for this product's worker, or `null` outside a container.
 *
 * @example
 * ```ts
 * import { holdWorker } from "@parity/product-sdk-host";
 *
 * const hold = await holdWorker("sending messages");
 * await hold?.around(() => send(message));
 * ```
 */
export async function holdWorker(label: string, clock?: Clock): Promise<OperationHold | null> {
    const client = await getClient();
    return client ? new OperationHold(client, label, clock) : null;
}

if (import.meta.vitest) {
    const { test, expect, vi } = import.meta.vitest;
    const { okAsync } = await import("neverthrow");
    const { ManualClock } = await import("@parity/product-sdk-utils/testing");

    function fakeWorker() {
        let next = 1;
        const beginOperation = vi.fn(() => okAsync({ id: next++ }));
        const endOperation = vi.fn(() => okAsync(undefined));
        const client = { worker: { beginOperation, endOperation } } as unknown as TrUApiClient;
        return { client, beginOperation, endOperation };
    }

    test("overlapping work shares one operation, ended after the grace period", async () => {
        const clock = new ManualClock(0);
        const { client, beginOperation, endOperation } = fakeWorker();
        const hold = new OperationHold(client, "sending", clock);
        await Promise.all([hold.around(async () => 1), hold.around(async () => 2)]);
        expect(beginOperation).toHaveBeenCalledOnce();
        expect(beginOperation).toHaveBeenCalledWith({ label: "sending" });
        await clock.advance(OPERATION_GRACE_MS - 1);
        expect(endOperation).not.toHaveBeenCalled();
        await clock.advance(1);
        expect(endOperation).toHaveBeenCalledWith({ id: 1 });
    });

    test("work within the grace period keeps the same operation", async () => {
        const clock = new ManualClock(0);
        const { client, beginOperation, endOperation } = fakeWorker();
        const hold = new OperationHold(client, "sending", clock);
        await hold.around(async () => undefined);
        await clock.advance(1_000);
        await hold.around(async () => undefined);
        await clock.advance(OPERATION_GRACE_MS);
        expect(beginOperation).toHaveBeenCalledOnce();
        expect(endOperation).toHaveBeenCalledOnce();
    });

    test("a host without operations still runs the work", async () => {
        const hold = new OperationHold({} as TrUApiClient, "sending", new ManualClock(0));
        expect(await hold.around(async () => "done")).toBe("done");
    });

    test("holdWorker returns null outside a container", async () => {
        expect(await holdWorker("x")).toBeNull();
    });
}
