// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Create a PAPI 3 transaction creator from a QR-paired session.
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
 * const signer = await createSessionSigner(session, adapter);
 *
 * // Non-default derivation index, or a different productId:
 * const subSigner = await createSessionSignerForAccount(session, {
 *     productId: "my-product",
 *     derivationIndex: 3,
 * });
 *
 * await contract.publish.tx(domain, cid, { signer, origin });
 * ```
 */
import type { UserSession } from "@novasamatech/host-papp";
import { NoAllowanceError } from "@novasamatech/statement-store";
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";
import { AllowanceExpiredError } from "@parity/product-sdk-signer/errors";
import { createHostTxCreator, type HostTxRequest } from "@parity/product-sdk-host/tx-creator";
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { fromHex, toHex } from "@polkadot-api/utils";

import type { TerminalAdapter } from "./adapter.js";
import { type ProductSubtreeOptions, getProductSubtreePublicKey } from "./subtree-cache.js";

/**
 * Detect the statement-store `NoAllowanceError` — the chain-side rejection a
 * sign request hits when the session's statement-store allowance has lapsed.
 *
 * Walks the `cause` chain: host-papp may wrap the underlying submit failure
 * before it reaches the `createTransaction`/`signRaw` error channel. Besides
 * `instanceof`, matches by constructor name (a duplicated copy of
 * `@novasamatech/statement-store` in the module graph defeats `instanceof`)
 * and by the fixed message statement-store mints — the only signal left once
 * the error crossed a serialization boundary (`NoAllowanceError` never sets
 * `this.name`, so name-matching would never fire).
 */
function isNoAllowanceError(error: unknown): boolean {
    // Bounded walk — cause chains are short; the cap guards against cycles.
    for (let current = error, depth = 0; current != null && depth < 8; depth++) {
        if (current instanceof NoAllowanceError) return true;
        if (current instanceof Error) {
            if (
                current.constructor.name === "NoAllowanceError" ||
                current.message.includes("no allowance set")
            ) {
                return true;
            }
            current = current.cause;
        } else {
            break;
        }
    }
    return false;
}

/**
 * Map a sign failure to the typed {@link AllowanceExpiredError} when its cause
 * is the statement-store `NoAllowanceError`; `null` otherwise. Single decision
 * point for both sign paths — `signTx` (via `session.createTransaction`) and
 * `signBytes` (via `session.signRaw`) both submit through the statement store,
 * so the lapsed resource is always `"statementStore"`.
 *
 * The caller *throws* the returned error (a PAPI `TxCreator` reports failure
 * as a rejecting Promise), making allowance expiry a typed, catchable condition
 * rather than a generic `Error`.
 */
function toAllowanceExpiredError(error: unknown): AllowanceExpiredError | null {
    return isNoAllowanceError(error) ? new AllowanceExpiredError("statementStore", error) : null;
}

/**
 * Identifies which sub-account of a paired session should sign.
 *
 * Mirrors the `host-papp` wire format `productAccountId: [productId, index]`:
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
     * PAPI stamps this into the extrinsic's signer address and verifies against
     * it, so a mismatch produces an invalid signature.
     *
     * When omitted, the signer fetches the subtree key and derives it. Supply it
     * to skip that round trip.
     */
    publicKey?: Uint8Array;
}

export interface SessionSignerOptions extends ProductSubtreeOptions {
    /**
     * Pipeline version to prefer when the transaction names none. Defaults to 0.
     *
     * When that pipeline does not declare every extension the caller supplied,
     * for example in `customSignedExtensions`, the signer uses the lowest version
     * that does, and refuses a transaction no pipeline can carry. A wrapper that
     * writes its own extensions, such as `withAsPerson`, sets the version on the
     * transaction itself, and that always wins.
     */
    txExtVersion?: number;
}

/** Derived from the session so a codec change fails to compile here. */
type ProductAccountId = Parameters<UserSession["signRaw"]>[0]["productAccountId"];

/** `Raw` is a host capability the SDK does not expose. */
function toProductAccountId(ref: ProductAccountRef): ProductAccountId {
    return [ref.productId, { tag: "Index", value: ref.derivationIndex }];
}

/**
 * Build the host-papp `CreateTransactionRequest` for one host signing request.
 *
 * Forwards every extension verbatim as `{ id, extra, additionalSigned }`, with
 * no allow-list and no reshaping, so chain-specific extensions (e.g. `AsPgas`
 * on Paseo Next v2) survive. The mobile app uses these plus `txExtVersion` to
 * assemble and sign the extrinsic.
 *
 * Pure and synchronous so the wire-shape contract can be unit-tested without a
 * paired phone.
 */
function buildCreateTransactionRequest(
    productAccountId: ProductAccountId,
    request: HostTxRequest,
): Parameters<UserSession["createTransaction"]>[0] {
    return {
        payload: {
            tag: "v1" as const,
            value: {
                signer: productAccountId,
                genesisHash: request.genesisHash,
                callData: fromHex(request.callData),
                extensions: request.extensions.map(({ id, extra, additionalSigned }) => ({
                    id,
                    extra: fromHex(extra),
                    additionalSigned: fromHex(additionalSigned),
                })),
                txExtVersion: request.txExtVersion,
            },
        },
    };
}

/**
 * Send the request to the paired wallet's `createTransaction` and unwrap it.
 *
 * Extracted and named so the SSO round-trip + error handling can be
 * unit-tested without a real phone; payload assembly lives in
 * {@link makeTxSignTx} / {@link buildCreateTransactionRequest}.
 */
async function requestSignedTransaction(
    session: UserSession,
    request: Parameters<UserSession["createTransaction"]>[0],
): Promise<Uint8Array> {
    const result = await session.createTransaction(request);
    if (result.isErr()) {
        const expired = toAllowanceExpiredError(result.error);
        if (expired) throw expired;
        throw new Error(`Mobile transaction signing rejected: ${result.error.message}`);
    }
    // host-papp returns the fully signed extrinsic bytes.
    return result.value;
}

/**
 * Sign function for arbitrary-byte signing (the creator `signBytes`).
 *
 * Routes to `session.signRaw` under the `Bytes` tag — the wallet's
 * raw-bytes interactor, which applies the standard `<Bytes>...</Bytes>`
 * anti-phishing envelope before signing.
 *
 */
function makeRawBytesSignCallback(session: UserSession, productAccountId: ProductAccountId) {
    return async (data: Uint8Array): Promise<Uint8Array> => {
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Bytes", value: data },
        });

        if (result.isErr()) {
            const expired = toAllowanceExpiredError(result.error);
            if (expired) throw expired;
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }

        return result.value.signature;
    };
}

export const INCOMPLETE_SESSION_MESSAGE =
    'Stored login session is missing the root account public key. Run "logout" and then "login" to pair again.';

/**
 * The wallet's own root account key. Product accounts do **not** derive from it:
 * RFC-0022 puts two hard junctions in between.
 *
 * @throws {@link INCOMPLETE_SESSION_MESSAGE} if the session predates the
 *   `rootAccountId` field.
 */
export function sessionRootPublicKey(session: UserSession): Uint8Array {
    const rootAccountId = (session as { rootAccountId?: Uint8Array }).rootAccountId;
    const publicKey = rootAccountId ? new Uint8Array(rootAccountId) : new Uint8Array();
    if (publicKey.length !== 32) {
        throw new Error(INCOMPLETE_SESSION_MESSAGE);
    }
    return publicKey;
}

/**
 * The product account's sr25519 public key for `ref`.
 *
 * The one place product-account math happens, so a displayed address cannot
 * desync from what the signer signs with.
 *
 * @throws Error when the wallet is unreachable on a cold cache.
 */
export async function deriveProductPublicKey(
    session: UserSession,
    ref: ProductAccountRef,
    options?: ProductSubtreeOptions,
): Promise<Uint8Array> {
    const subtree = await getProductSubtreePublicKey(session, ref.productId, options);
    return deriveProductAccountPublicKey(subtree, { tag: "Index", value: ref.derivationIndex });
}

async function buildSessionSigner(
    session: UserSession,
    ref: ProductAccountRef,
    options?: SessionSignerOptions,
): Promise<CommonSignerTxCreator> {
    const productAccountId = toProductAccountId(ref);

    // No fallback to session.remoteAccount.accountId: that signs valid bytes for
    // the wrong address, which is worse than failing.
    const publicKey = ref.publicKey ?? (await deriveProductPublicKey(session, ref, options));

    // The wallet builds and signs the extrinsic through host-papp
    // `createTransaction`, so it can show a decoded transaction. Raw bytes keep
    // the `Bytes` tag, so the wallet applies the `<Bytes>` envelope exactly once.
    return createHostTxCreator(
        publicKey,
        async (request) =>
            toHex(
                await requestSignedTransaction(
                    session,
                    buildCreateTransactionRequest(productAccountId, request),
                ),
            ) as `0x${string}`,
        makeRawBytesSignCallback(session, productAccountId),
        options?.txExtVersion ?? 0,
    );
}

/**
 * Create a PAPI 3 transaction creator backed by a QR-paired mobile wallet session,
 * using the session's **default account** (`derivationIndex: 0`).
 *
 * For non-default sub-accounts, use {@link createSessionSignerForAccount}.
 *
 * @param session The paired user session.
 * @param adapter The {@link TerminalAdapter} that loaded the session. Its `appId`
 *   is used as the `productId` in the wire request.
 * @param publicKey The product account's sr25519 public key for
 *   `[adapter.appId, 0]`. Optional — when omitted it's fetched and derived.
 *   See {@link ProductAccountRef.publicKey}.
 */
export function createSessionSigner(
    session: UserSession,
    adapter: TerminalAdapter,
    publicKey?: Uint8Array,
    options?: SessionSignerOptions,
): Promise<CommonSignerTxCreator> {
    return buildSessionSigner(
        session,
        { productId: adapter.appId, derivationIndex: 0, publicKey },
        { appId: adapter.appId, ...options },
    );
}

/**
 * Create a PAPI 3 transaction creator for a specific sub-account of a paired session.
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
    options?: SessionSignerOptions,
): Promise<CommonSignerTxCreator> {
    return buildSessionSigner(session, ref, options);
}

if (import.meta.vitest) {
    const pid = (productId: string, derivationIndex: number) =>
        toProductAccountId({ productId, derivationIndex });

    const { describe, test, expect, vi, beforeEach } = import.meta.vitest;
    const { ok, err } = await import("neverthrow");
    const { readFileSync } = await import("node:fs");
    const { decAnyMetadata, unifyMetadata } = await import("@polkadot-api/substrate-bindings");
    const { seedToAccount } = await import("@parity/product-sdk-keys");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { clearProductSubtreeMemo } = await import("./subtree-cache.js");

    // Soft derivation runs ristretto255 point math and rejects arbitrary bytes.
    const DEV_ROOT_PUBLIC_KEY = seedToAccount(
        "bottom drive obey lake curtain smoke basket hold race lonely fit walk",
        "",
    ).publicKey;
    const DEV_SUBTREE_PUBLIC_KEY = seedToAccount(
        "bottom drive obey lake curtain smoke basket hold race lonely fit walk",
        "//product//test-app",
    ).publicKey;

    let storageDir: string;
    beforeEach(() => {
        clearProductSubtreeMemo();
        storageDir = mkdtempSync(join(tmpdir(), "signer-test-"));
        return () => rmSync(storageDir, { recursive: true, force: true });
    });

    const cache = () => ({ storageDir });

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
        rootAccountId?: number[] | null;
        /** Pass `null` to simulate a wallet that refuses the subtree request. */
        subtreePublicKey?: Uint8Array | null;
        id?: string;
    }): UserSession {
        const accountIdBytes = opts.accountIdBytes ?? new Array(32).fill(0).map((_, i) => i);
        const rootAccountId =
            opts.rootAccountId === undefined ? Array.from(DEV_ROOT_PUBLIC_KEY) : opts.rootAccountId;
        const subtree =
            opts.subtreePublicKey === undefined ? DEV_SUBTREE_PUBLIC_KEY : opts.subtreePublicKey;
        return {
            id: opts.id ?? `session-${Math.random()}`,
            remoteAccount: { accountId: accountIdBytes },
            ...(rootAccountId === null ? {} : { rootAccountId: new Uint8Array(rootAccountId) }),
            getProductSubtree: vi.fn(async () =>
                subtree === null ? err(new Error("wallet refused")) : ok(subtree),
            ),
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

    function fakeAdapter(appId: string): TerminalAdapter {
        // Only the `appId` field matters for these tests.
        return { appId } as unknown as TerminalAdapter;
    }

    describe("createSessionSigner", () => {
        test("derives the product key from the fetched subtree key", async () => {
            const walletBytes = Array.from({ length: 32 }, (_, i) => i);
            const session = makeSession({ accountIdBytes: walletBytes });
            const signer = await createSessionSigner(
                session,
                fakeAdapter("test-app"),
                undefined,
                cache(),
            );

            const expected = deriveProductAccountPublicKey(DEV_SUBTREE_PUBLIC_KEY, {
                tag: "Index",
                value: 0,
            });
            expect(signer.publicKey).toEqual(expected);
            // The two keys the old code wrongly used in this slot.
            expect(signer.publicKey).not.toEqual(new Uint8Array(walletBytes));
            expect(signer.publicKey).not.toEqual(DEV_ROOT_PUBLIC_KEY);
        });

        test("throws rather than signing when the wallet refuses the subtree", async () => {
            await expect(
                createSessionSigner(
                    makeSession({ subtreePublicKey: null }),
                    fakeAdapter("test-app"),
                    undefined,
                    cache(),
                ),
            ).rejects.toThrow(/wallet refused/);
        });

        test("uses the host-supplied product-account public key when provided", async () => {
            const walletBytes = Array.from({ length: 32 }, (_, i) => i);
            const productKey = new Uint8Array(32).fill(0xab);
            const session = makeSession({ accountIdBytes: walletBytes });
            const signer = await createSessionSigner(
                session,
                fakeAdapter("test-app"),
                productKey,
                cache(),
            );
            expect(signer.publicKey).toEqual(productKey);
            expect(session.getProductSubtree).not.toHaveBeenCalled();
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
            const signer = await createSessionSigner(
                session,
                fakeAdapter("test-app"),
                undefined,
                cache(),
            );

            const out = await signer.signBytes(new Uint8Array([1, 2, 3]));
            expect(out).toEqual(sig);

            // The bytes route forwards data verbatim under the `Bytes` tag.
            // Mobile applies the <Bytes>...</Bytes> envelope on its side.
            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: ProductAccountId;
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(pid("test-app", 0));
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
            const signer = await createSessionSigner(
                session,
                fakeAdapter("test-app"),
                undefined,
                cache(),
            );

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
            const signer = await createSessionSigner(
                session,
                fakeAdapter("test-app"),
                undefined,
                cache(),
            );

            await expect(signer.signBytes(new Uint8Array([1]))).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
        });
    });

    describe("buildCreateTransactionRequest — tx payload (the AsPgas fix)", () => {
        // Asserts the wire shape handed to the wallet. The full PAPI round trip
        // through the phone is exercised by the manual smoke test in
        // `manual-tests/qr-pair-and-sign.mjs`, since CI cannot drive a real phone.

        // People runtime 3004000 declares two pipelines, so both versions are real.
        const PEOPLE = toHex(
            new Uint8Array(
                readFileSync(
                    new URL(
                        "../../descriptors/.papi/metadata/previewnet_individuality.scale",
                        import.meta.url,
                    ),
                ),
            ),
        );
        const pipelines = unifyMetadata(decAnyMetadata(PEOPLE)).extrinsic.extensionsByVersion;
        // Each payload carries the extensions of the pipeline it signs on, as a
        // caller would, so the version the signer chooses from them is that one.
        const filledOn = (version: number) =>
            pipelines[version]
                .filter(({ identifier }) => identifier !== "VerifyMultiSignature")
                .map(({ identifier }, index) => ({
                    id: identifier,
                    extra: toHex(new Uint8Array([index])),
                    additionalSigned: "0x",
                }));
        const payloadOn = (version: number) => ({
            version: 1 as const,
            signer: null,
            callData: "0xca11",
            extensions: filledOn(version),
            txExtVersion: null,
            context: {
                metadata: PEOPLE,
                token: null,
                bestBlockHeight: 1,
                bestBlockHash: `0x${"11".repeat(32)}`,
                genesisHash: `0x${"22".repeat(32)}`,
            },
        });
        const onPipeline = (version: number) =>
            filledOn(version).map(({ id, extra, additionalSigned }) => ({
                id,
                extra: fromHex(extra),
                additionalSigned: fromHex(additionalSigned),
            }));

        test.each([
            { account: "default", txExtVersion: undefined },
            { account: "default", txExtVersion: 1 },
            { account: "explicit", txExtVersion: undefined },
            { account: "explicit", txExtVersion: 1 },
        ])(
            "$account signer forwards txExtVersion $txExtVersion and its pipeline extensions",
            async ({ account, txExtVersion }) => {
                const signed = new Uint8Array([0xab, 0xcd]);
                const session = makeSession({ createTransaction: async () => ok(signed) });
                const publicKey = new Uint8Array(32).fill(0xab);
                const options = { ...cache(), txExtVersion };
                const signer =
                    account === "default"
                        ? await createSessionSigner(
                              session,
                              fakeAdapter("my-app"),
                              publicKey,
                              options,
                          )
                        : await createSessionSignerForAccount(
                              session,
                              { productId: "other-app", derivationIndex: 3, publicKey },
                              options,
                          );
                const payload = payloadOn(txExtVersion ?? 0);
                const result = await signer(payload, {}, {} as never, false);
                expect(session.createTransaction).toHaveBeenCalledExactlyOnceWith({
                    payload: {
                        tag: "v1",
                        value: {
                            signer: account === "default" ? pid("my-app", 0) : pid("other-app", 3),
                            genesisHash: payload.context.genesisHash,
                            callData: new Uint8Array([0xca, 0x11]),
                            extensions: onPipeline(txExtVersion ?? 0),
                            txExtVersion: txExtVersion ?? 0,
                        },
                    },
                });
                expect(result).toBe(toHex(signed));
            },
        );

        const hostRequest = {
            genesisHash: `0x${"22".repeat(32)}` as const,
            callData: "0x00" as const,
            extensions: [
                { id: "CheckNonce", extra: "0x07" as const, additionalSigned: "0x" as const },
                { id: "AsPgas", extra: "0xdead" as const, additionalSigned: "0xbeef" as const },
            ],
            txExtVersion: 0,
        };

        test("takes the genesis hash and version from the host request", () => {
            const req = buildCreateTransactionRequest(pid("my-app", 0), hostRequest);
            expect(req.payload.value.genesisHash).toBe(hostRequest.genesisHash);
            expect(req.payload.value.txExtVersion).toBe(0);
        });

        test("maps every extension to { id, extra, additionalSigned } bytes", () => {
            const req = buildCreateTransactionRequest(pid("my-app", 0), hostRequest);
            expect(req.payload.value.extensions).toEqual([
                {
                    id: "CheckNonce",
                    extra: new Uint8Array([0x07]),
                    additionalSigned: new Uint8Array([]),
                },
                {
                    id: "AsPgas",
                    extra: new Uint8Array([0xde, 0xad]),
                    additionalSigned: new Uint8Array([0xbe, 0xef]),
                },
            ]);
        });
    });

    describe("requestSignedTransaction — SSO round-trip", () => {
        const request = buildCreateTransactionRequest(pid("my-app", 0), {
            genesisHash: `0x${"01".repeat(32)}`,
            callData: "0x00",
            extensions: [],
            txExtVersion: 0,
        });

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

        test("throws AllowanceExpiredError when the failure is a NoAllowanceError", async () => {
            const underlying = new NoAllowanceError();
            const session = makeSession({
                createTransaction: async () => err(underlying),
            });

            await expect(requestSignedTransaction(session, request)).rejects.toBeInstanceOf(
                AllowanceExpiredError,
            );
            await expect(requestSignedTransaction(session, request)).rejects.toMatchObject({
                name: "AllowanceExpiredError",
                resource: "statementStore",
                cause: underlying,
            });
        });

        test("throws AllowanceExpiredError for a wire-serialized failure (message match only)", async () => {
            // After a serialization boundary the NoAllowanceError prototype
            // and constructor name are gone — the fixed message upstream
            // mints is the only remaining signal. This pins statement-store's
            // exact wording: if upstream rephrases it, this test fails
            // instead of the classification silently downgrading to the
            // generic rejection.
            // Pin upstream's wording first: if statement-store rephrases the
            // message, this assertion fails loudly.
            expect(new NoAllowanceError().message).toBe(
                "Submit failed, no allowance set for account",
            );

            const serialized = new Error("Submit failed, no allowance set for account");
            const session = makeSession({
                createTransaction: async () => err(serialized),
            });

            await expect(requestSignedTransaction(session, request)).rejects.toBeInstanceOf(
                AllowanceExpiredError,
            );
        });

        test("throws AllowanceExpiredError when the NoAllowanceError is wrapped as a cause", async () => {
            // host-papp may wrap the chain-side submit failure before it hits
            // the createTransaction error channel — the cause chain must be
            // walked, not just the top-level error.
            const wrapped = new Error("submitRequest failed", { cause: new NoAllowanceError() });
            const session = makeSession({
                createTransaction: async () => err(wrapped),
            });

            await expect(requestSignedTransaction(session, request)).rejects.toBeInstanceOf(
                AllowanceExpiredError,
            );
        });

        test("a non-allowance Error still surfaces as the generic rejection", async () => {
            const session = makeSession({
                createTransaction: async () => err(new Error("transport exploded")),
            });

            await expect(requestSignedTransaction(session, request)).rejects.toThrow(
                "Mobile transaction signing rejected: transport exploded",
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

            const callback = makeRawBytesSignCallback(session, [
                "my-app",
                { tag: "Index", value: 5 },
            ]);
            await callback(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: ProductAccountId;
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(pid("my-app", 5));
            expect(req.data.tag).toBe("Bytes");
            expect(Array.from(req.data.value)).toEqual([0xde, 0xad, 0xbe, 0xef]);
        });

        test("returns the raw signature bytes from the mobile response", async () => {
            const sig = new Uint8Array([0x42]);
            const session = makeSession({
                signRaw: async () => ok({ signature: sig }),
            });

            const callback = makeRawBytesSignCallback(session, [
                "my-app",
                { tag: "Index", value: 0 },
            ]);
            const out = await callback(new Uint8Array([0]));

            expect(out).toBe(sig);
        });

        test("throws AllowanceExpiredError when the failure is a NoAllowanceError", async () => {
            const underlying = new NoAllowanceError();
            const session = makeSession({
                signRaw: async () => err(underlying),
            });

            const callback = makeRawBytesSignCallback(session, [
                "my-app",
                { tag: "Index", value: 0 },
            ]);
            await expect(callback(new Uint8Array([1]))).rejects.toBeInstanceOf(
                AllowanceExpiredError,
            );
            await expect(callback(new Uint8Array([1]))).rejects.toMatchObject({
                resource: "statementStore",
                cause: underlying,
            });
        });

        test("a non-allowance failure still surfaces as the generic rejection", async () => {
            const session = makeSession({
                signRaw: async () => err(new Error("user declined")),
            });

            const callback = makeRawBytesSignCallback(session, [
                "my-app",
                { tag: "Index", value: 0 },
            ]);
            await expect(callback(new Uint8Array([1]))).rejects.toThrow(
                "Mobile signing rejected: user declined",
            );
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

            const signer = await createSessionSignerForAccount(
                session,
                { productId: "my-app", derivationIndex: 7 },
                cache(),
            );
            await signer.signBytes(new Uint8Array([10, 20, 30]));

            expect(captured).toHaveLength(1);
            const req = captured[0] as {
                productAccountId: ProductAccountId;
                data: { tag: string; value: Uint8Array };
            };
            expect(req.productAccountId).toEqual(pid("my-app", 7));
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

            const signer = await createSessionSignerForAccount(
                session,
                { productId: "external-product", derivationIndex: 0 },
                cache(),
            );
            await signer.signBytes(new Uint8Array([1]));

            const req = captured[0] as {
                productAccountId: ProductAccountId;
            };
            expect(req.productAccountId).toEqual(pid("external-product", 0));
        });
    });
}
