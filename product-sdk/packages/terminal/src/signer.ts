/**
 * Create a PolkadotSigner from a QR-paired session.
 *
 * Bridges the host-papp session to polkadot-api's `PolkadotSigner` interface
 * via `getPolkadotSignerFromPjs`, routing **transaction signing** through
 * `session.signPayload` (no `<Bytes>...</Bytes>` envelope — produces a
 * signature over the actual extrinsic payload) and **raw-message signing**
 * through `session.signRaw` (mobile applies the `<Bytes>...</Bytes>`
 * anti-phishing wrap, as expected for arbitrary data).
 *
 * Routing both paths through `signRaw` (as a single PAPI callback would)
 * causes the chain to reject every tx with `BadProof`, because the mobile
 * wallet wraps even SCALE-encoded extrinsic payloads with the anti-phishing
 * envelope before signing.
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
import { getPolkadotSignerFromPjs } from "polkadot-api/pjs-signer";
import type { PolkadotSigner } from "polkadot-api";
import { fromHex, toHex } from "@polkadot-api/utils";
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

/**
 * Defensively prepend `0x` if missing.
 *
 * PAPI's PJS payload types every hex field as `HexString = string` with no
 * runtime check. In practice the signed-extension mappers always emit
 * `0x`-prefixed values, so this should never actually prepend — but the
 * type contract doesn't guarantee it, and host-papp's SCALE codec rejects
 * unprefixed input. Mirrors the `asHex` helper in `@novasamatech/product-sdk`'s
 * in-host signer for the same reason.
 */
function asHex(v: string): `0x${string}` {
    return v.startsWith("0x") ? (v as `0x${string}`) : (`0x${v}` as `0x${string}`);
}

/**
 * Build the `signPayload` callback PAPI calls for transaction signing.
 *
 * Translates PAPI's `SignerPayloadJSON` into host-papp's `SigningPayloadRequest`
 * and routes it to `session.signPayload` — the mobile wallet's JSON-payload
 * interactor, which signs the SCALE-encoded extrinsic directly with no
 * `<Bytes>` envelope. This is the path that the chain accepts.
 *
 * Exported only via `import.meta.vitest` so unit tests can exercise the
 * callback wiring directly without standing up a full PolkadotSigner.
 */
function makeSignPayloadCallback(session: UserSession, productAccountId: [string, number]) {
    return async (
        payload: PjsSignerPayloadJSON,
    ): Promise<{
        signature: `0x${string}`;
        signedTransaction?: `0x${string}`;
    }> => {
        const result = await session.signPayload({
            productAccountId,
            blockHash: asHex(payload.blockHash),
            blockNumber: asHex(payload.blockNumber),
            era: asHex(payload.era),
            genesisHash: asHex(payload.genesisHash),
            method: asHex(payload.method),
            nonce: asHex(payload.nonce),
            specVersion: asHex(payload.specVersion),
            tip: asHex(payload.tip),
            transactionVersion: asHex(payload.transactionVersion),
            signedExtensions: payload.signedExtensions,
            version: payload.version,
            // PJS types `assetId` as `number | object`. In practice the
            // ChargeAssetTxPayment mapper always emits a hex string when
            // present — we trust the mapper rather than runtime-checking,
            // matching the reference in `@novasamatech/product-sdk`.
            assetId:
                payload.assetId !== undefined
                    ? (payload.assetId as never as `0x${string}`)
                    : undefined,
            metadataHash: payload.metadataHash ? asHex(payload.metadataHash) : undefined,
            mode: payload.mode,
            withSignedTransaction: payload.withSignedTransaction,
        });

        if (result.isErr()) {
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }

        return {
            signature: toHex(result.value.signature) as `0x${string}`,
            signedTransaction: result.value.signedTransaction
                ? (toHex(result.value.signedTransaction) as `0x${string}`)
                : undefined,
        };
    };
}

/**
 * Build the `signRaw` callback PAPI calls for arbitrary-byte signing
 * (`signBytes`). Routes to `session.signRaw` — the mobile wallet's raw
 * interactor, which applies the standard `<Bytes>...</Bytes>` anti-phishing
 * envelope before signing. Correct for arbitrary user data.
 *
 * Exported only via `import.meta.vitest` for direct unit tests.
 */
function makeSignRawCallback(session: UserSession, productAccountId: [string, number]) {
    return async (
        payload: PjsSignRawPayload,
    ): Promise<{
        id: number;
        signature: `0x${string}`;
    }> => {
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Bytes" as const, value: fromHex(payload.data) },
        });

        if (result.isErr()) {
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }

        return {
            id: 0,
            signature: toHex(result.value.signature) as `0x${string}`,
        };
    };
}

// Minimal local types for the PJS signer callback inputs. We don't import
// the full `SignerPayloadJSON` from `@polkadot-api/pjs-signer` because the
// version installed exposes it as an internal type. These are structurally
// correct for the fields we actually read.
type PjsSignerPayloadJSON = {
    address: string;
    assetId?: number | object;
    blockHash: string;
    blockNumber: string;
    era: string;
    genesisHash: string;
    metadataHash?: string;
    method: string;
    mode?: number;
    nonce: string;
    specVersion: string;
    tip: string;
    transactionVersion: string;
    signedExtensions: string[];
    version: number;
    withSignedTransaction?: boolean;
};

type PjsSignRawPayload = {
    address: string;
    data: string;
    type: "bytes";
};

function buildSessionSigner(session: UserSession, ref: ProductAccountRef): PolkadotSigner {
    const accountId = new Uint8Array(session.remoteAccount.accountId);
    const productAccountId: [string, number] = [ref.productId, ref.derivationIndex];
    // getPolkadotSignerFromPjs accepts a "0x"-prefixed hex AccountId as its
    // address; it derives `publicKey` from this directly. The host-papp side
    // of signing identifies accounts by `productAccountId` instead, so we
    // ignore the `address` field PAPI later passes back into our callbacks
    // and use the closure-captured `productAccountId` there.
    const accountIdHex = asHex(toHex(accountId));

    return getPolkadotSignerFromPjs(
        accountIdHex,
        makeSignPayloadCallback(session, productAccountId),
        makeSignRawCallback(session, productAccountId),
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
     * Build a minimal `UserSession`-shaped stub. Both `signPayload` and
     * `signRaw` accept request-capturing functions so tests can assert on
     * exactly which host-papp method got called and with what payload.
     */
    function makeSession(opts: {
        signPayload?: (req: unknown) => Promise<unknown>;
        signRaw?: (req: unknown) => Promise<unknown>;
        accountIdBytes?: number[];
    }): UserSession {
        const accountIdBytes = opts.accountIdBytes ?? new Array(32).fill(0).map((_, i) => i);
        return {
            remoteAccount: { accountId: accountIdBytes },
            signPayload: vi.fn(
                opts.signPayload ??
                    (async () => {
                        throw new Error("signPayload not stubbed in this test");
                    }),
            ),
            signRaw: vi.fn(
                opts.signRaw ??
                    (async () => {
                        throw new Error("signRaw not stubbed in this test");
                    }),
            ),
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
                makeSession({ accountIdBytes: bytes }),
                fakeAdapter("test-app"),
            );
            expect(signer.publicKey).toEqual(new Uint8Array(bytes));
        });

        test("signBytes routes through session.signRaw (anti-phishing wrap path)", async () => {
            const sig = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
            const captured: unknown[] = [];
            const session = makeSession({
                signRaw: async (req) => {
                    captured.push(req);
                    return ok({ signature: sig });
                },
            });
            const signer = createSessionSigner(session, fakeAdapter("test-app"));

            const out = await signer.signBytes(new Uint8Array([1, 2, 3]));
            expect(out).toEqual(sig);

            // The raw path forwards the bytes verbatim under the "Bytes" tag.
            // Mobile applies the <Bytes>...</Bytes> envelope on its side.
            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: [string, number];
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(["test-app", 0]);
            expect(req.data.tag).toBe("Bytes");
            expect(req.data.value).toBeInstanceOf(Uint8Array);
        });

        test("signBytes does NOT call session.signPayload (regression guard for BadProof bug)", async () => {
            // The original bug was a single PAPI callback that funneled
            // every signing operation through signRaw. After the fix,
            // signBytes is the only thing that should reach signRaw —
            // signPayload is reserved for tx signing. This test guards
            // against accidentally regressing to the unified-callback shape.
            const session = makeSession({
                signRaw: async () => ok({ signature: new Uint8Array([1]) }),
            });
            const signer = createSessionSigner(session, fakeAdapter("test-app"));

            await signer.signBytes(new Uint8Array([1, 2, 3]));

            const sessionWithSpies = session as unknown as {
                signPayload: { mock: { calls: unknown[] } };
                signRaw: { mock: { calls: unknown[] } };
            };
            expect(sessionWithSpies.signPayload.mock.calls).toHaveLength(0);
            expect(sessionWithSpies.signRaw.mock.calls).toHaveLength(1);
        });

        test("signRaw throws with a clear error when the mobile rejects", async () => {
            const session = makeSession({
                signRaw: async () => err({ message: "user declined" }),
            });
            const signer = createSessionSigner(session, fakeAdapter("test-app"));

            await expect(signer.signBytes(new Uint8Array([1]))).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
        });
    });

    describe("makeSignPayloadCallback — tx signing path (the BadProof fix)", () => {
        // These tests directly exercise the callback PAPI hands to its
        // signTx implementation. Bypassing PAPI's getPolkadotSignerFromPjs
        // wrapper lets us assert on the wire-format translation without
        // building synthetic extrinsic metadata. The full signTx → callback
        // → chain roundtrip is gated by the manual smoke test.

        function pjsPayload(overrides: Partial<PjsSignerPayloadJSON> = {}): PjsSignerPayloadJSON {
            return {
                address: `0x${"00".repeat(32)}`,
                blockHash: `0x${"11".repeat(32)}`,
                blockNumber: "0x12345678",
                era: "0xc501",
                genesisHash: `0x${"22".repeat(32)}`,
                method: "0xabcdef",
                nonce: "0x00000001",
                specVersion: "0x000003e8",
                tip: `0x${"0".repeat(32)}`,
                transactionVersion: "0x00000001",
                signedExtensions: ["CheckMortality", "CheckNonce"],
                version: 4,
                ...overrides,
            };
        }

        test("forwards request to session.signPayload with the right productAccountId", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                signPayload: async (req) => {
                    captured.push(req);
                    return ok({
                        signature: new Uint8Array([0xaa, 0xbb]),
                        signedTransaction: undefined,
                    });
                },
            });

            const callback = makeSignPayloadCallback(session, ["my-app", 0]);
            await callback(pjsPayload());

            expect(captured).toHaveLength(1);
            const req = captured[0] as { productAccountId: [string, number] };
            expect(req.productAccountId).toEqual(["my-app", 0]);
        });

        test("does NOT call session.signRaw (BadProof regression guard)", async () => {
            // The whole point of the fix: tx signing must hit signPayload,
            // never signRaw. signRaw applies the <Bytes> envelope which
            // produces signatures the chain rejects.
            const session = makeSession({
                signPayload: async () =>
                    ok({ signature: new Uint8Array([1]), signedTransaction: undefined }),
            });

            const callback = makeSignPayloadCallback(session, ["my-app", 0]);
            await callback(pjsPayload());

            const sessionWithSpies = session as unknown as {
                signPayload: { mock: { calls: unknown[] } };
                signRaw: { mock: { calls: unknown[] } };
            };
            expect(sessionWithSpies.signPayload.mock.calls).toHaveLength(1);
            expect(sessionWithSpies.signRaw.mock.calls).toHaveLength(0);
        });

        test("translates every PJS hex field into a 0x-prefixed string", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                signPayload: async (req) => {
                    captured.push(req);
                    return ok({
                        signature: new Uint8Array([0]),
                        signedTransaction: undefined,
                    });
                },
            });

            const callback = makeSignPayloadCallback(session, ["my-app", 0]);
            await callback(
                pjsPayload({
                    // Mix of already-prefixed and unprefixed inputs to exercise asHex.
                    blockHash: `0x${"ab".repeat(32)}`,
                    nonce: "1234abcd", // unprefixed — asHex must add 0x
                }),
            );

            const req = captured[0] as Record<string, unknown>;
            for (const field of [
                "blockHash",
                "blockNumber",
                "era",
                "genesisHash",
                "method",
                "nonce",
                "specVersion",
                "tip",
                "transactionVersion",
            ]) {
                expect(req[field], `${field} must be 0x-prefixed`).toMatch(/^0x[0-9a-fA-F]*$/);
            }
        });

        test("forwards optional fields when present, omits when absent", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                signPayload: async (req) => {
                    captured.push(req);
                    return ok({
                        signature: new Uint8Array([0]),
                        signedTransaction: undefined,
                    });
                },
            });

            const callback = makeSignPayloadCallback(session, ["my-app", 0]);
            await callback(
                pjsPayload({
                    metadataHash: "0xdeadbeef",
                    mode: 1,
                    withSignedTransaction: true,
                    assetId: "0xfeed" as unknown as object,
                }),
            );

            const req = captured[0] as Record<string, unknown>;
            expect(req.metadataHash).toBe("0xdeadbeef");
            expect(req.mode).toBe(1);
            expect(req.withSignedTransaction).toBe(true);
            expect(req.assetId).toBe("0xfeed");
        });

        test("hex-encodes signature and signedTransaction in the PJS return shape", async () => {
            const session = makeSession({
                signPayload: async () =>
                    ok({
                        signature: new Uint8Array([0xab, 0xcd]),
                        signedTransaction: new Uint8Array([0x01, 0x02, 0x03]),
                    }),
            });

            const callback = makeSignPayloadCallback(session, ["my-app", 0]);
            const result = await callback(pjsPayload());

            expect(result.signature).toBe("0xabcd");
            expect(result.signedTransaction).toBe("0x010203");
        });

        test("omits signedTransaction when host-papp returns undefined", async () => {
            const session = makeSession({
                signPayload: async () =>
                    ok({
                        signature: new Uint8Array([0]),
                        signedTransaction: undefined,
                    }),
            });

            const callback = makeSignPayloadCallback(session, ["my-app", 0]);
            const result = await callback(pjsPayload());

            expect(result.signature).toBe("0x00");
            expect(result.signedTransaction).toBeUndefined();
        });

        test("throws a clear error when the mobile rejects", async () => {
            const session = makeSession({
                signPayload: async () => err({ message: "user declined" }),
            });

            const callback = makeSignPayloadCallback(session, ["my-app", 0]);

            await expect(callback(pjsPayload())).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
        });
    });

    describe("makeSignRawCallback", () => {
        test("forwards request to session.signRaw with the right productAccountId", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                signRaw: async (req) => {
                    captured.push(req);
                    return ok({ signature: new Uint8Array([0xff]) });
                },
            });

            const callback = makeSignRawCallback(session, ["my-app", 5]);
            await callback({
                address: `0x${"00".repeat(32)}`,
                data: "0xdeadbeef",
                type: "bytes",
            });

            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: [string, number];
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(["my-app", 5]);
            expect(req.data.tag).toBe("Bytes");
            expect(Array.from(req.data.value)).toEqual([0xde, 0xad, 0xbe, 0xef]);
        });

        test("hex-encodes signature in the PJS return shape with id: 0", async () => {
            const session = makeSession({
                signRaw: async () => ok({ signature: new Uint8Array([0x42]) }),
            });

            const callback = makeSignRawCallback(session, ["my-app", 0]);
            const result = await callback({
                address: `0x${"00".repeat(32)}`,
                data: "0x00",
                type: "bytes",
            });

            expect(result.id).toBe(0);
            expect(result.signature).toBe("0x42");
        });
    });

    describe("createSessionSignerForAccount", () => {
        test("forwards productAccountId from the explicit ref", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                signRaw: async (req) => {
                    captured.push(req);
                    return ok({ signature: new Uint8Array([42]) });
                },
            });

            const signer = createSessionSignerForAccount(session, {
                productId: "my-app",
                derivationIndex: 7,
            });
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
            const session = makeSession({
                signRaw: async (req) => {
                    captured.push(req);
                    return ok({ signature: new Uint8Array([0]) });
                },
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
