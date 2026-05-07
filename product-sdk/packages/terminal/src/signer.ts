/**
 * Create a PolkadotSigner from a QR-paired session.
 *
 * Bridges the host-papp session's `signRaw()` to polkadot-api's
 * `PolkadotSigner` interface via `getPolkadotSigner`, enabling
 * mobile-approved signing for on-chain transactions from the CLI.
 *
 * @example
 * ```ts
 * const [session] = adapter.sessions.sessions.read();
 * // Convenience overload — infers [adapter.appId, 0] for the default account:
 * const signer = createSessionSigner(session, adapter);
 * // Explicit form — when you need a non-zero derivation index or a different productId:
 * const signer = createSessionSigner(session, ["my-product", 3]);
 * await contract.publish.tx(domain, cid, { signer, origin });
 * ```
 */
import { getPolkadotSigner } from "polkadot-api/signer";
import type { PolkadotSigner } from "polkadot-api";
import type { UserSession } from "@novasamatech/host-papp";
import type { TerminalAdapter } from "./adapter.js";

/**
 * Create a `PolkadotSigner` backed by a QR-paired mobile wallet session.
 *
 * Each signing request is sent to the paired phone for approval.
 * The returned signer can be used anywhere polkadot-api expects a signer.
 *
 * @param session The paired user session.
 * @param productAccountIdOrAdapter Either an explicit
 *   `[productId, derivationIndex]` tuple, or a {@link TerminalAdapter} from which
 *   `[adapter.appId, 0]` is inferred for the default account. Pass the explicit
 *   tuple when you need a derivation index ≠ 0 or a `productId` different from
 *   the adapter's `appId`.
 */
export function createSessionSigner(
    session: UserSession,
    productAccountIdOrAdapter: [string, number] | TerminalAdapter,
): PolkadotSigner {
    const productAccountId: [string, number] = Array.isArray(productAccountIdOrAdapter)
        ? productAccountIdOrAdapter
        : [productAccountIdOrAdapter.appId, 0];

    const accountId = new Uint8Array(session.remoteAccount.accountId);

    return getPolkadotSigner(
        accountId,
        "Sr25519",
        async (data: Uint8Array): Promise<Uint8Array> => {
            const result = await session.signRaw({
                productAccountId,
                data: { tag: "Bytes" as const, value: data },
            });

            if (result.isErr()) {
                throw new Error(`Mobile signing rejected: ${result.error.message}`);
            }

            return result.value.signature;
        },
    );
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;
    const { ok, err } = await import("neverthrow");

    /**
     * Build a minimal `UserSession`-shaped stub whose `signRaw` is a Vitest spy.
     * Only the fields used by `createSessionSigner` are populated.
     */
    function makeSession(
        signRaw: (req: unknown) => Promise<unknown>,
        accountIdBytes: number[] = new Array(32).fill(0).map((_, i) => i),
    ): UserSession {
        return {
            remoteAccount: { accountId: accountIdBytes },
            signRaw: vi.fn(signRaw),
        } as unknown as UserSession;
    }

    describe("createSessionSigner", () => {
        test("exposes Sr25519 public key matching remoteAccount.accountId", () => {
            const bytes = Array.from({ length: 32 }, (_, i) => i);
            const signer = createSessionSigner(
                makeSession(async () => ok({ signature: new Uint8Array() }), bytes),
                ["test-app", 0],
            );
            expect(signer.publicKey).toEqual(new Uint8Array(bytes));
        });

        test("signBytes returns signature on success", async () => {
            const sig = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
            const session = makeSession(async () => ok({ signature: sig }));
            const signer = createSessionSigner(session, ["test-app", 0]);

            const out = await signer.signBytes(new Uint8Array([1, 2, 3]));
            expect(out).toEqual(sig);
        });

        test("forwards request as { tag: 'Bytes', value } with productAccountId tuple", async () => {
            const captured: unknown[] = [];
            const session = makeSession(async (req) => {
                captured.push(req);
                return ok({ signature: new Uint8Array([42]) });
            });
            const signer = createSessionSigner(session, ["my-app", 7]);

            // Note: polkadot-api wraps signBytes payloads in <Bytes>...</Bytes>
            // before invoking the underlying callback. We only care here that
            // our wrapping (`{ tag: 'Bytes', value }` envelope + productAccountId
            // tuple) is correct — not the byte-level payload contents.
            await signer.signBytes(new Uint8Array([10, 20, 30]));

            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: [string, number];
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(["my-app", 7]);
            expect(req.data.tag).toBe("Bytes");
            expect(req.data.value).toBeInstanceOf(Uint8Array);
        });

        test("signBytes throws when mobile signing is rejected", async () => {
            const session = makeSession(async () => err({ message: "user declined" }));
            const signer = createSessionSigner(session, ["test-app", 0]);

            await expect(signer.signBytes(new Uint8Array([1]))).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
        });

        test("adapter overload infers productAccountId as [adapter.appId, 0]", async () => {
            const captured: unknown[] = [];
            const session = makeSession(async (req) => {
                captured.push(req);
                return ok({ signature: new Uint8Array([1]) });
            });
            // Cheapest stand-in for a TerminalAdapter — only the `appId` field matters here.
            const fakeAdapter = { appId: "inferred-app" } as unknown as TerminalAdapter;

            const signer = createSessionSigner(session, fakeAdapter);
            await signer.signBytes(new Uint8Array([1, 2, 3]));

            const req = captured[0] as { productAccountId: [string, number] };
            expect(req.productAccountId).toEqual(["inferred-app", 0]);
        });
    });
}
