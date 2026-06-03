// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Create a PolkadotSigner from a QR-paired session.
 *
 * Routes **transaction signing** through `session.createTransaction` — the
 * host-papp `CreateTransactionRequest`/`CreateTransactionResponse` SSO
 * message pair. We hand the mobile app the structured
 * `ProductAccountTransaction` (`signer`, `genesisHash`, `callData`, the
 * per-extension `{ extra, additionalSigned }`, and `txExtVersion`) and it
 * **builds and signs** the full extrinsic, returning the signed bytes.
 *
 * Two properties fall out of this:
 *  - The wallet can **decode and display** the transaction instead of
 *    blind-signing an opaque hash (which is what the older
 *    `session.signRaw({ tag: "Payload" })` route did).
 *  - Every signed extension the chain declares — including ones PAPI's PJS
 *    adapter doesn't know (e.g. `AsPgas` on Paseo Next v2) — is forwarded
 *    verbatim as `{ id, extra, additionalSigned }`, so nothing is lost in
 *    translation.
 *
 * **Raw-message signing** (`signBytes`) keeps the `session.signRaw` `Bytes`
 * tag so the wallet applies the `<Bytes>...</Bytes>` anti-phishing wrap once
 * on its side. Correct for arbitrary user data; wrong for extrinsic payloads
 * (which is why the two paths split).
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
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import type { PolkadotSigner } from "polkadot-api";

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
    /**
     * The **product account's** sr25519 public key (32 bytes), as derived by the
     * host for `[productId, derivationIndex]`.
     *
     * PAPI stamps this into the extrinsic's signer address and verifies the
     * signature against it, so it must be the *product* account's key — not the
     * wallet's selected/root account (`session.remoteAccount.accountId`). A
     * mismatch produces an invalid signature.
     *
     * When omitted, the signer falls back to the session's selected account,
     * which is only correct when the product account *is* the selected account.
     */
    publicKey?: Uint8Array;
}

/**
 * The `signedExtensions` map PAPI hands to `PolkadotSigner.signTx`: keyed by
 * extension identifier, each entry carries the SCALE-encoded `extra` (goes in
 * the extrinsic body, as `value`) and `additionalSigned` (implicit data).
 */
type PapiSignedExtensions = Parameters<PolkadotSigner["signTx"]>[1];

/**
 * Build the host-papp `CreateTransactionRequest` from PAPI's `signTx` inputs.
 *
 * Maps every signed extension verbatim into the wire `{ id, extra,
 * additionalSigned }` triplets — no allow-list, no reshaping — so chain-specific
 * extensions (e.g. `AsPgas` on Paseo Next v2) survive. The mobile app uses
 * these plus `txExtVersion` to assemble and sign the extrinsic.
 *
 * Pure and synchronous so the wire-shape contract can be unit-tested without a
 * paired phone; the metadata decode + SSO round-trip live in {@link makeTxSignTx}.
 */
function buildCreateTransactionRequest(
    productAccountId: [string, number],
    callData: Uint8Array,
    signedExtensions: PapiSignedExtensions,
    txExtVersion: number,
): Parameters<UserSession["createTransaction"]>[0] {
    const checkGenesis = signedExtensions.CheckGenesis;
    if (!checkGenesis) {
        throw new Error(
            "Cannot build transaction: chain did not provide the CheckGenesis signed extension",
        );
    }

    return {
        payload: {
            tag: "v1" as const,
            value: {
                signer: productAccountId,
                // CheckGenesis carries the genesis hash as its additionalSigned (implicit) data.
                genesisHash: checkGenesis.additionalSigned,
                callData,
                extensions: Object.values(signedExtensions).map(
                    ({ identifier, value, additionalSigned }) => ({
                        id: identifier,
                        extra: value,
                        additionalSigned,
                    }),
                ),
                txExtVersion,
            },
        },
    };
}

/**
 * Transaction-extension version the mobile app must assemble:
 *  - Extrinsic V4 → `0` (the protocol mandates 0 for V4).
 *  - Extrinsic V5 → the runtime's version (highest the metadata advertises).
 */
function txExtVersionFromMetadata(metadata: Uint8Array): number {
    const decoded = unifyMetadata(decAnyMetadata(metadata));
    const latestVersion = decoded.extrinsic.version.reduce((max, v) => Math.max(max, v), 0);
    return latestVersion === 4 ? 0 : latestVersion;
}

/**
 * Send the request to the paired wallet's `createTransaction` and unwrap it.
 *
 * Extracted and named so the SSO round-trip + error handling can be
 * unit-tested without a real phone or chain metadata; the metadata decode and
 * payload assembly live in {@link makeTxSignTx} / {@link buildCreateTransactionRequest}.
 */
async function requestSignedTransaction(
    session: UserSession,
    request: Parameters<UserSession["createTransaction"]>[0],
): Promise<Uint8Array> {
    const result = await session.createTransaction(request);
    if (result.isErr()) {
        throw new Error(`Mobile transaction signing rejected: ${result.error.message}`);
    }
    // host-papp returns the fully signed extrinsic bytes.
    return result.value;
}

/**
 * The `signTx` function PAPI calls for transaction signing.
 *
 * Forwards the structured payload to the paired mobile wallet via
 * `session.createTransaction`; the wallet builds + signs the extrinsic and
 * returns the signed bytes. Unlike the old `signRaw({ tag: "Payload" })`
 * route, the wallet sees a real transaction (not opaque bytes) and unknown
 * signed extensions are preserved by {@link buildCreateTransactionRequest}.
 */
function makeTxSignTx(
    session: UserSession,
    productAccountId: [string, number],
): PolkadotSigner["signTx"] {
    return async (callData, signedExtensions, metadata) =>
        requestSignedTransaction(
            session,
            buildCreateTransactionRequest(
                productAccountId,
                callData,
                signedExtensions,
                txExtVersionFromMetadata(metadata),
            ),
        );
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

    // The signer's public key must be the *product* account's key — the one the
    // wallet signs with for [productId, derivationIndex] — not the wallet's
    // selected root account. PAPI stamps this into the extrinsic's address and
    // verifies against it, so a mismatch yields an invalid signature. The host
    // supplies the derived key via `ref.publicKey`; we fall back to the
    // session's selected account only when none is provided (i.e. product
    // account == selected account). See {@link ProductAccountRef.publicKey}.
    const publicKey = ref.publicKey ?? new Uint8Array(session.remoteAccount.accountId);

    return {
        publicKey,
        // Transaction signing → host-papp `createTransaction`: the wallet builds
        // and signs the extrinsic, so it can show a decoded tx (no `<Bytes>`
        // envelope) and unknown signed extensions (e.g. `AsPgas`) survive.
        signTx: makeTxSignTx(session, productAccountId),
        // Arbitrary-byte signing keeps the `Bytes` tag so the wallet applies the
        // `<Bytes>...</Bytes>` anti-phishing envelope exactly once on its side
        // (correct for non-extrinsic user data).
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
 * @param publicKey The product account's sr25519 public key for
 *   `[adapter.appId, 0]`, as derived by the host. See
 *   {@link ProductAccountRef.publicKey}; omit only when the product account is
 *   the session's selected account.
 */
export function createSessionSigner(
    session: UserSession,
    adapter: TerminalAdapter,
    publicKey?: Uint8Array,
): PolkadotSigner {
    return buildSessionSigner(session, { productId: adapter.appId, derivationIndex: 0, publicKey });
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
     * Build a minimal `UserSession`-shaped stub. `signPayload`, `signRaw`, and
     * `createTransaction` accept request-capturing functions so tests can assert
     * on exactly which host-papp method got called and with what payload.
     */
    function makeSession(opts: {
        signPayload?: (req: unknown) => Promise<unknown>;
        signRaw?: (req: unknown) => Promise<unknown>;
        createTransaction?: (req: unknown) => Promise<unknown>;
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
            createTransaction: vi.fn(
                opts.createTransaction ??
                    (async () => {
                        throw new Error("createTransaction not stubbed in this test");
                    }),
            ),
        } as unknown as UserSession;
    }

    /**
     * A minimal PAPI `signedExtensions` entry. `value` is the SCALE-encoded
     * "extra" (extrinsic body); `additionalSigned` is the implicit data.
     */
    function ext(identifier: string, value: number[], additionalSigned: number[]) {
        return {
            identifier,
            value: new Uint8Array(value),
            additionalSigned: new Uint8Array(additionalSigned),
        };
    }

    function fakeAdapter(appId: string): TerminalAdapter {
        // Only the `appId` field matters for these tests.
        return { appId } as unknown as TerminalAdapter;
    }

    describe("createSessionSigner", () => {
        test("falls back to remoteAccount.accountId when no product key is passed", () => {
            const bytes = Array.from({ length: 32 }, (_, i) => i);
            const signer = createSessionSigner(
                makeSession({ accountIdBytes: bytes }),
                fakeAdapter("test-app"),
            );
            expect(signer.publicKey).toEqual(new Uint8Array(bytes));
        });

        test("uses the host-supplied product-account public key when provided", () => {
            // The product account's key differs from the wallet's selected
            // account (`remoteAccount.accountId`). PAPI must stamp the *product*
            // key into the extrinsic, so the explicit key must win.
            const walletBytes = Array.from({ length: 32 }, (_, i) => i);
            const productKey = new Uint8Array(32).fill(0xab);
            const signer = createSessionSigner(
                makeSession({ accountIdBytes: walletBytes }),
                fakeAdapter("test-app"),
                productKey,
            );
            expect(signer.publicKey).toEqual(productKey);
            expect(signer.publicKey).not.toEqual(new Uint8Array(walletBytes));
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

    describe("buildCreateTransactionRequest — tx payload (the AsPgas fix)", () => {
        // Asserts the wire shape handed to the wallet. The full PAPI signTx →
        // metadata decode → SSO round-trip is exercised by the manual smoke
        // test in `manual-tests/qr-pair-and-sign.mjs` since CI cannot drive
        // a real phone.

        const checkGenesis = ext("CheckGenesis", [], [0x11, 0x22, 0x33]);

        test("wraps the payload as v1 with signer, callData, and txExtVersion", () => {
            const callData = new Uint8Array([0xca, 0x11]);
            const req = buildCreateTransactionRequest(
                ["my-app", 3],
                callData,
                { CheckGenesis: checkGenesis },
                5,
            );
            expect(req.payload.tag).toBe("v1");
            expect(req.payload.value.signer).toEqual(["my-app", 3]);
            expect(req.payload.value.callData).toEqual(callData);
            expect(req.payload.value.txExtVersion).toBe(5);
        });

        test("takes the genesis hash from CheckGenesis.additionalSigned", () => {
            const req = buildCreateTransactionRequest(
                ["my-app", 0],
                new Uint8Array([0]),
                { CheckGenesis: checkGenesis },
                0,
            );
            expect(req.payload.value.genesisHash).toEqual(new Uint8Array([0x11, 0x22, 0x33]));
        });

        test("maps every signed extension to { id, extra, additionalSigned }", () => {
            const req = buildCreateTransactionRequest(
                ["my-app", 0],
                new Uint8Array([0]),
                { CheckGenesis: checkGenesis, CheckNonce: ext("CheckNonce", [0x07], []) },
                0,
            );
            expect(req.payload.value.extensions).toEqual([
                {
                    id: "CheckGenesis",
                    extra: new Uint8Array([]),
                    additionalSigned: new Uint8Array([0x11, 0x22, 0x33]),
                },
                {
                    id: "CheckNonce",
                    extra: new Uint8Array([0x07]),
                    additionalSigned: new Uint8Array([]),
                },
            ]);
        });

        test("preserves an unknown signed extension verbatim (e.g. AsPgas)", () => {
            // The whole reason for moving off PJS: an extension PAPI's PJS
            // adapter doesn't know must pass through untouched.
            const req = buildCreateTransactionRequest(
                ["my-app", 0],
                new Uint8Array([0]),
                { CheckGenesis: checkGenesis, AsPgas: ext("AsPgas", [0xde, 0xad], [0xbe, 0xef]) },
                0,
            );
            expect(req.payload.value.extensions).toContainEqual({
                id: "AsPgas",
                extra: new Uint8Array([0xde, 0xad]),
                additionalSigned: new Uint8Array([0xbe, 0xef]),
            });
        });

        test("throws a clear error when CheckGenesis is absent", () => {
            expect(() =>
                buildCreateTransactionRequest(["my-app", 0], new Uint8Array([0]), {}, 0),
            ).toThrow(/CheckGenesis/);
        });
    });

    describe("requestSignedTransaction — SSO round-trip", () => {
        const request = buildCreateTransactionRequest(
            ["my-app", 0],
            new Uint8Array([0]),
            { CheckGenesis: ext("CheckGenesis", [], [0x01]) },
            0,
        );

        test("returns the signed extrinsic bytes from the mobile response", async () => {
            const signed = new Uint8Array([0xab, 0xcd, 0xef]);
            const session = makeSession({ createTransaction: async () => ok(signed) });

            const out = await requestSignedTransaction(session, request);
            expect(out).toBe(signed);
        });

        test("calls session.createTransaction — never signRaw/signPayload — with the request", async () => {
            const captured: unknown[] = [];
            const session = makeSession({
                createTransaction: async (req) => {
                    captured.push(req);
                    return ok(new Uint8Array([1]));
                },
            });

            await requestSignedTransaction(session, request);

            expect(captured).toEqual([request]);
            const spies = session as unknown as {
                signPayload: { mock: { calls: unknown[] } };
                signRaw: { mock: { calls: unknown[] } };
                createTransaction: { mock: { calls: unknown[] } };
            };
            expect(spies.createTransaction.mock.calls).toHaveLength(1);
            expect(spies.signPayload.mock.calls).toHaveLength(0);
            expect(spies.signRaw.mock.calls).toHaveLength(0);
        });

        test("throws a clear error when the mobile rejects", async () => {
            const session = makeSession({
                createTransaction: async () => err({ message: "user declined" }),
            });
            await expect(requestSignedTransaction(session, request)).rejects.toThrow(
                "Mobile transaction signing rejected: user declined",
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
