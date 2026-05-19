/**
 * Create a PolkadotSigner from a QR-paired session.
 *
 * Builds the `PolkadotSigner` via PAPI-native `getPolkadotSigner` and routes
 * **transaction signing** through `session.signRaw` with the `Payload` tag
 * — a tagged-bytes wire route in host-papp that signs the SCALE-encoded
 * extrinsic payload as-is, with no `<Bytes>...</Bytes>` anti-phishing
 * envelope. PAPI assembles the full payload (`callData ‖ extras ‖
 * additionalSigneds`) from runtime metadata, so every signed extension
 * declared by the chain — including extensions not known to PAPI's PJS
 * adapter (e.g. `AsPgas` on Paseo Next v2) — survives end-to-end as opaque
 * bytes that the wallet just signs.
 *
 * **Raw-message signing** (`signBytes`) keeps the `Bytes` tag so the wallet
 * applies the anti-phishing wrap once on its side. Correct for arbitrary
 * user data; wrong for extrinsic payloads (which is why the two paths split).
 *
 * Bypasses `getPolkadotSignerFromPjs` whose built-in mapper table covers
 * only eight extensions and throws `PJS does not support this
 * signed-extension: <name>` on anything else.
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
import type { UserSession } from "@novasamatech/host-papp";
import { toHex } from "@polkadot-api/utils";
import type { PolkadotSigner } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";

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
 * Sign function PAPI calls for transaction signing.
 *
 * PAPI's `getPolkadotSigner` assembles `callData ‖ extras ‖ additionalSigneds`
 * for every extension declared in `metadata.extrinsic.signedExtensions`,
 * concatenates them, blake2-hashes the result if >256 bytes, and hands the
 * bytes here. We forward them to the mobile wallet under the `Payload` tag
 * — opaque hex; no envelope — and return the raw signature.
 *
 * Any extension carried by the chain survives because the bytes are the
 * source of truth: the wallet does not inspect the payload's structure, it
 * just signs it.
 */
function makeTxSignCallback(session: UserSession, productAccountId: [string, number]) {
    return async (toSign: Uint8Array): Promise<Uint8Array> => {
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Payload", value: toHex(toSign) },
        });

        if (result.isErr()) {
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }

        return result.value.signature;
    };
}

/**
 * Sign function for arbitrary-byte signing (`PolkadotSigner.signBytes`).
 *
 * Routes to `session.signRaw` under the `Bytes` tag — the wallet's
 * raw-bytes interactor, which applies the standard `<Bytes>...</Bytes>`
 * anti-phishing envelope before signing.
 *
 * Provided as a separate function so `buildSessionSigner` can override
 * the `signBytes` produced by `getPolkadotSigner` (which would otherwise
 * funnel raw-bytes signing through the same `sign` callback as tx signing
 * — the wrong wire tag for arbitrary user data).
 */
function makeRawBytesSignCallback(session: UserSession, productAccountId: [string, number]) {
    return async (data: Uint8Array): Promise<Uint8Array> => {
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Bytes", value: data },
        });

        if (result.isErr()) {
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }

        return result.value.signature;
    };
}

function buildSessionSigner(session: UserSession, ref: ProductAccountRef): PolkadotSigner {
    const productAccountId: [string, number] = [ref.productId, ref.derivationIndex];
    const publicKey = new Uint8Array(session.remoteAccount.accountId);

    // host-papp pairs sr25519 accounts only — `createSr25519Secret` /
    // `deriveSr25519PublicKey` are the sole key-derivation primitives in
    // its SSO flow. If host-papp ever supports mixed schemes, this becomes
    // a session-driven field.
    const base = getPolkadotSigner(
        publicKey,
        "Sr25519",
        makeTxSignCallback(session, productAccountId),
    );

    // Override `signBytes`: `getPolkadotSigner` returns `signBytes:
    // getSignBytes(sign)`, which wraps incoming data with
    // `<Bytes>...</Bytes>` and then funnels it through the same `sign`
    // callback as tx signing. Routing pre-wrapped bytes through the
    // `Payload` tag would let the wallet sign the wrap as-is (the
    // `Payload` route deliberately skips the wallet-side envelope),
    // producing signatures that don't verify against the un-wrapped user
    // data. Routing `signBytes` through the `Bytes` tag instead applies
    // the envelope exactly once, on the wallet side.
    return {
        ...base,
        signBytes: makeRawBytesSignCallback(session, productAccountId),
    };
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
    const { fromHex } = await import("@polkadot-api/utils");

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

        test("signBytes routes through session.signRaw with the Bytes tag", async () => {
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

            // The bytes route forwards data verbatim under the `Bytes` tag.
            // Mobile applies the <Bytes>...</Bytes> envelope on its side.
            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: [string, number];
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(["test-app", 0]);
            expect(req.data.tag).toBe("Bytes");
            expect(req.data.value).toEqual(new Uint8Array([1, 2, 3]));
        });

        test("signBytes never calls session.signPayload (legacy-path regression guard)", async () => {
            // The PJS-bridged path used to route tx signing through
            // `session.signPayload`. The new PAPI-native path retires
            // `signPayload` entirely for this signer. This test guards
            // against accidentally re-introducing the legacy call.
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

        test("signBytes throws with a clear error when the mobile rejects", async () => {
            const session = makeSession({
                signRaw: async () => err({ message: "user declined" }),
            });
            const signer = createSessionSigner(session, fakeAdapter("test-app"));

            await expect(signer.signBytes(new Uint8Array([1]))).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
        });
    });

    describe("makeTxSignCallback — tx signing path (the AsPgas fix)", () => {
        // Bypasses PAPI's getPolkadotSigner wrapper to assert directly on
        // the wire translation. The full PAPI signTx → callback → chain
        // roundtrip is exercised by the manual smoke test in
        // `manual-tests/qr-pair-and-sign.mjs` since CI cannot drive a real
        // phone.

        test("forwards bytes-to-sign under the Payload tag with the right productAccountId", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                signRaw: async (req) => {
                    captured.push(req);
                    return ok({ signature: new Uint8Array([0xaa, 0xbb]) });
                },
            });

            const callback = makeTxSignCallback(session, ["my-app", 0]);
            await callback(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: [string, number];
                data: { tag: string; value: string };
            };
            expect(req.productAccountId).toEqual(["my-app", 0]);
            expect(req.data.tag).toBe("Payload");
            // Value is the 0x-prefixed hex of the input bytes — the wallet
            // signs this opaque payload without inspecting it, which is
            // what lets new signed extensions (e.g. AsPgas) survive.
            expect(req.data.value).toBe("0xdeadbeef");
        });

        test("never calls session.signPayload (legacy PJS-shape regression guard)", async () => {
            // The whole point of the AsPgas fix: tx signing must hit
            // session.signRaw with the Payload tag, never session.signPayload.
            // session.signPayload's wire codec has fixed slots and cannot
            // carry arbitrary signed-extension extras.
            const session = makeSession({
                signRaw: async () => ok({ signature: new Uint8Array([1]) }),
            });

            const callback = makeTxSignCallback(session, ["my-app", 0]);
            await callback(new Uint8Array([1, 2, 3]));

            const sessionWithSpies = session as unknown as {
                signPayload: { mock: { calls: unknown[] } };
                signRaw: { mock: { calls: unknown[] } };
            };
            expect(sessionWithSpies.signPayload.mock.calls).toHaveLength(0);
            expect(sessionWithSpies.signRaw.mock.calls).toHaveLength(1);
        });

        test("returns the raw signature bytes from the mobile response", async () => {
            const sig = new Uint8Array([0xab, 0xcd, 0xef]);
            const session = makeSession({
                signRaw: async () => ok({ signature: sig }),
            });

            const callback = makeTxSignCallback(session, ["my-app", 0]);
            const out = await callback(new Uint8Array([0]));

            expect(out).toBe(sig);
        });

        test("preserves arbitrary signed-extension payload bytes verbatim", async () => {
            // Simulates what PAPI hands the callback when the chain
            // declares a custom signed extension: an opaque byte stream
            // built from `callData ‖ extras ‖ additionalSigneds`. The
            // callback must not interpret or reshape these bytes; it
            // forwards them as-is under the Payload tag.
            const customExtensionBytes = new Uint8Array([
                // arbitrary scale-encoded extension payload — content
                // doesn't matter, only that it round-trips exactly
                0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x42, 0x43, 0x44,
            ]);
            const captured: unknown[] = [];
            const session = makeSession({
                signRaw: async (req) => {
                    captured.push(req);
                    return ok({ signature: new Uint8Array([0]) });
                },
            });

            const callback = makeTxSignCallback(session, ["my-app", 0]);
            await callback(customExtensionBytes);

            const req = captured[0] as { data: { value: string } };
            expect(fromHex(req.data.value)).toEqual(customExtensionBytes);
        });

        test("throws a clear error when the mobile rejects", async () => {
            const session = makeSession({
                signRaw: async () => err({ message: "user declined" }),
            });

            const callback = makeTxSignCallback(session, ["my-app", 0]);

            await expect(callback(new Uint8Array([0]))).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
        });
    });

    describe("makeRawBytesSignCallback", () => {
        test("forwards data verbatim under the Bytes tag with the right productAccountId", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                signRaw: async (req) => {
                    captured.push(req);
                    return ok({ signature: new Uint8Array([0xff]) });
                },
            });

            const callback = makeRawBytesSignCallback(session, ["my-app", 5]);
            await callback(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: [string, number];
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(["my-app", 5]);
            expect(req.data.tag).toBe("Bytes");
            expect(Array.from(req.data.value)).toEqual([0xde, 0xad, 0xbe, 0xef]);
        });

        test("returns the raw signature bytes from the mobile response", async () => {
            const sig = new Uint8Array([0x42]);
            const session = makeSession({
                signRaw: async () => ok({ signature: sig }),
            });

            const callback = makeRawBytesSignCallback(session, ["my-app", 0]);
            const out = await callback(new Uint8Array([0]));

            expect(out).toBe(sig);
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
