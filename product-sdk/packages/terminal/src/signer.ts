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
 *
 * // Default account — uses [adapter.appId, 0]:
 * const signer = createSessionSigner(session, adapter);
 *
 * // Non-default derivation index, or a different productId:
 * const subSigner = createSessionSignerForAccount(session, {
 *     productId: "my-product",
 *     derivationIndex: 3,
 * });
 *
 * await contract.publish.tx(domain, cid, { signer, origin });
 * ```
 */
import { getPolkadotSigner } from "polkadot-api/signer";
import type { PolkadotSigner } from "polkadot-api";
import type { UserSession } from "@novasamatech/host-papp";
import type { TerminalAdapter } from "./adapter.js";

/**
 * Identifies which sub-account of a paired session should sign.
 *
 * Mirrors the `host-papp` wire format `productAccountId: [productId, derivationIndex]`:
 * `productId` is the dotNS-style identifier for the requesting product (matches
 * the adapter's `appId` in normal usage); `derivationIndex` is the BIP32-style
 * child-key index, where `0` is the session's default account.
 */
export interface ProductAccountRef {
    /** The product identifier. Usually equal to the adapter's `appId`. */
    productId: string;
    /** Child-key derivation index. `0` is the default account. */
    derivationIndex: number;
}

function buildSessionSigner(session: UserSession, ref: ProductAccountRef): PolkadotSigner {
    const accountId = new Uint8Array(session.remoteAccount.accountId);
    const productAccountId: [string, number] = [ref.productId, ref.derivationIndex];

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

/**
 * Create a `PolkadotSigner` backed by a QR-paired mobile wallet session,
 * using the session's **default account** (`derivationIndex: 0`).
 *
 * For non-default sub-accounts, use {@link createSessionSignerForAccount}.
 *
 * @param session The paired user session.
 * @param adapter The {@link TerminalAdapter} that loaded the session. Its `appId`
 *   is used as the `productId` in the wire request.
 */
export function createSessionSigner(
    session: UserSession,
    adapter: TerminalAdapter,
): PolkadotSigner {
    return buildSessionSigner(session, { productId: adapter.appId, derivationIndex: 0 });
}

/**
 * Create a `PolkadotSigner` for a specific sub-account of a paired session.
 *
 * Use this when you need a derivation index other than `0`, or a `productId`
 * different from the adapter's `appId`. For the common default-account case,
 * prefer {@link createSessionSigner}.
 *
 * @param session The paired user session.
 * @param ref The product account to sign as: `{ productId, derivationIndex }`.
 */
export function createSessionSignerForAccount(
    session: UserSession,
    ref: ProductAccountRef,
): PolkadotSigner {
    return buildSessionSigner(session, ref);
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

    function fakeAdapter(appId: string): TerminalAdapter {
        // Only the `appId` field matters for these tests.
        return { appId } as unknown as TerminalAdapter;
    }

    describe("createSessionSigner", () => {
        test("exposes Sr25519 public key matching remoteAccount.accountId", () => {
            const bytes = Array.from({ length: 32 }, (_, i) => i);
            const signer = createSessionSigner(
                makeSession(async () => ok({ signature: new Uint8Array() }), bytes),
                fakeAdapter("test-app"),
            );
            expect(signer.publicKey).toEqual(new Uint8Array(bytes));
        });

        test("signBytes returns signature on success", async () => {
            const sig = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
            const session = makeSession(async () => ok({ signature: sig }));
            const signer = createSessionSigner(session, fakeAdapter("test-app"));

            const out = await signer.signBytes(new Uint8Array([1, 2, 3]));
            expect(out).toEqual(sig);
        });

        test("forwards request with productAccountId = [adapter.appId, 0]", async () => {
            const captured: unknown[] = [];
            const session = makeSession(async (req) => {
                captured.push(req);
                return ok({ signature: new Uint8Array([1]) });
            });

            const signer = createSessionSigner(session, fakeAdapter("inferred-app"));
            await signer.signBytes(new Uint8Array([1, 2, 3]));

            const req = captured[0] as { productAccountId: [string, number] };
            expect(req.productAccountId).toEqual(["inferred-app", 0]);
        });

        test("signBytes throws when mobile signing is rejected", async () => {
            const session = makeSession(async () => err({ message: "user declined" }));
            const signer = createSessionSigner(session, fakeAdapter("test-app"));

            await expect(signer.signBytes(new Uint8Array([1]))).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
        });
    });

    describe("createSessionSignerForAccount", () => {
        test("forwards request with the given productId and derivationIndex", async () => {
            const captured: unknown[] = [];
            const session = makeSession(async (req) => {
                captured.push(req);
                return ok({ signature: new Uint8Array([42]) });
            });

            const signer = createSessionSignerForAccount(session, {
                productId: "my-app",
                derivationIndex: 7,
            });

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

        test("supports a productId different from any adapter's appId", async () => {
            const captured: unknown[] = [];
            const session = makeSession(async (req) => {
                captured.push(req);
                return ok({ signature: new Uint8Array([0]) });
            });

            const signer = createSessionSignerForAccount(session, {
                productId: "external-product",
                derivationIndex: 0,
            });
            await signer.signBytes(new Uint8Array([1]));

            const req = captured[0] as { productAccountId: [string, number] };
            expect(req.productAccountId).toEqual(["external-product", 0]);
        });
    });
}
