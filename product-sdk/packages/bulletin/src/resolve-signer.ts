import { getPreimageManager } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import type { PolkadotSigner } from "polkadot-api";

import { BulletinHostUnavailableError } from "./errors.js";

const log = createLogger("bulletin");

/**
 * Discriminated union describing how data will be uploaded to the Bulletin Chain.
 *
 * - `"preimage"` — the host handles signing and chain submission via its preimage API.
 * - `"signer"`   — a `TransactionStorage.store` transaction is signed and submitted directly.
 */
export type UploadStrategy =
    | { kind: "preimage"; submit: (data: Uint8Array) => Promise<string> }
    | { kind: "signer"; signer: PolkadotSigner };

/**
 * Determine the upload strategy for the Bulletin Chain.
 *
 * Resolution order:
 * 1. If an explicit signer is provided, use it directly.
 * 2. Otherwise, use the host preimage API (the SDK is designed to run inside a container).
 *
 * @param explicitSigner - Optional signer provided by the caller. When present,
 *                         skips host auto-detection entirely.
 * @returns The resolved upload strategy.
 * @throws {Error} If no signer is provided and the host preimage API is unavailable.
 */
export async function resolveUploadStrategy(
    explicitSigner?: PolkadotSigner,
): Promise<UploadStrategy> {
    if (explicitSigner) {
        log.debug("using explicit signer provided by caller");
        return { kind: "signer", signer: explicitSigner };
    }

    // Use the host preimage API (inside container)
    const preimageManager = await getPreimageManager();
    if (preimageManager) {
        log.info("using host preimage API for bulletin upload");
        return { kind: "preimage", submit: (data) => preimageManager.submit(data) };
    }

    throw new BulletinHostUnavailableError("upload");
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    describe("resolveUploadStrategy", () => {
        test("returns explicit signer when provided", async () => {
            const signer = { publicKey: new Uint8Array(32) } as PolkadotSigner;
            const strategy = await resolveUploadStrategy(signer);
            expect(strategy.kind).toBe("signer");
            if (strategy.kind === "signer") {
                expect(strategy.signer).toBe(signer);
            }
        });

        // Note: Tests for host preimage manager integration require e2e testing
        // as they depend on the actual host container environment.
        // The explicit signer path above validates the core logic.
    });
}
