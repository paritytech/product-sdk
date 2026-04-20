import { isInsideContainer } from "@parity/product-sdk-host";
import { createLogger } from "@parity/product-sdk-logger";
import { createDevSigner } from "@parity/product-sdk-tx";
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
 * 1. If an explicit signer is provided, use it directly (backwards-compatible path).
 * 2. If running inside a host container (Polkadot Desktop / Mobile) and
 *    `@novasamatech/product-sdk` is available, use the host preimage API —
 *    the host signs and submits the transaction automatically.
 * 3. Otherwise fall back to Alice's dev signer (pre-funded on test chains).
 *
 * @param explicitSigner - Optional signer provided by the caller. When present,
 *                         skips auto-detection entirely.
 * @returns The resolved upload strategy.
 */
export async function resolveUploadStrategy(
    explicitSigner?: PolkadotSigner,
): Promise<UploadStrategy> {
    if (explicitSigner) {
        log.debug("using explicit signer provided by caller");
        return { kind: "signer", signer: explicitSigner };
    }

    const inContainer = await isInsideContainer();

    if (inContainer) {
        try {
            const sdk = await import("@novasamatech/product-sdk");
            log.info("inside host container — using preimage API for bulletin upload");
            return { kind: "preimage", submit: (data) => sdk.preimageManager.submit(data) };
        } catch {
            log.warn(
                "inside host container but @novasamatech/product-sdk is unavailable, " +
                    "falling back to dev signer",
            );
        }
    }

    log.info("using dev signer (Alice) for bulletin upload");
    return { kind: "signer", signer: createDevSigner("Alice") };
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

        test("falls back to dev signer outside container (Node env, no window)", async () => {
            const strategy = await resolveUploadStrategy();
            expect(strategy.kind).toBe("signer");
            if (strategy.kind === "signer") {
                expect(strategy.signer).toBeDefined();
                expect(strategy.signer.publicKey).toBeInstanceOf(Uint8Array);
            }
        });

        test("returns preimage strategy when inside container with SDK", async () => {
            const fakeWindow = { top: null, __HOST_WEBVIEW_MARK__: true };
            vi.stubGlobal("window", fakeWindow);
            vi.doMock("@novasamatech/product-sdk", () => ({
                preimageManager: { submit: async (_data: Uint8Array) => "0xdeadbeef" },
                sandboxProvider: { isCorrectEnvironment: () => true },
            }));
            try {
                const strategy = await resolveUploadStrategy();
                expect(strategy.kind).toBe("preimage");
            } finally {
                vi.doUnmock("@novasamatech/product-sdk");
                vi.unstubAllGlobals();
            }
        });

        test("falls back to dev signer when inside container but SDK unavailable", async () => {
            const fakeWindow = { top: null, __HOST_WEBVIEW_MARK__: true };
            vi.stubGlobal("window", fakeWindow);
            vi.doMock("@novasamatech/product-sdk", () => {
                throw new Error("module not found");
            });
            try {
                const strategy = await resolveUploadStrategy();
                expect(strategy.kind).toBe("signer");
            } finally {
                vi.doUnmock("@novasamatech/product-sdk");
                vi.unstubAllGlobals();
            }
        });
    });
}
