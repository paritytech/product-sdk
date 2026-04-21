import { createLogger } from "@parity/product-sdk-logger";
import type { PolkadotSigner } from "polkadot-api";

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
    try {
        const sdk = await import("@novasamatech/product-sdk");
        log.info("using host preimage API for bulletin upload");
        return { kind: "preimage", submit: (data) => sdk.preimageManager.submit(data) };
    } catch {
        throw new Error(
            "Host preimage API unavailable. Ensure you are running inside a host container (Polkadot Browser / Desktop), " +
                "or provide an explicit signer.",
        );
    }
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

        test("returns preimage strategy when SDK available", async () => {
            vi.doMock("@novasamatech/product-sdk", () => ({
                preimageManager: { submit: async (_data: Uint8Array) => "0xdeadbeef" },
            }));
            try {
                const strategy = await resolveUploadStrategy();
                expect(strategy.kind).toBe("preimage");
            } finally {
                vi.doUnmock("@novasamatech/product-sdk");
            }
        });

        test("throws when SDK unavailable and no explicit signer", async () => {
            vi.doMock("@novasamatech/product-sdk", () => {
                throw new Error("module not found");
            });
            try {
                await expect(resolveUploadStrategy()).rejects.toThrow(
                    /Host preimage API unavailable/,
                );
            } finally {
                vi.doUnmock("@novasamatech/product-sdk");
            }
        });
    });
}
