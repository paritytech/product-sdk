// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Client-side RFC-0007 product-entropy derivation for terminal (QR/SSO) sessions.
 *
 * Specified normatively by host-spec §C.8 "RFC-0007 product entropy"
 * ({@link https://github.com/paritytech/host-spec/blob/adb3989208ae1c2107dbf0159611353e6989422c/spec/C-account-derivation.md?plain=1#L129-L147 | spec/C-account-derivation.md}):
 *
 *   layer1 = blake2b256_keyed(key = utf8("product-entropy-derivation"), msg = rootAccountSecret)
 *   layer2 = blake2b256_keyed(key = blake2b256(utf8(productId)),        msg = layer1)
 *   result = blake2b256_keyed(key = callerKey,                          msg = layer2)
 *
 * The paired {@link UserSession} already carries layer 1 as `rootEntropySource`,
 * so this module computes only layers 2 and 3 — no host round-trip. The output
 * matches what an in-container app gets from `@parity/product-sdk-host`'s
 * `deriveEntropy` for the same wallet + product + key, so entropy-derived keys
 * interoperate across web (in-container) and terminal (QR/SSO) clients.
 *
 * Layer 1's input is the raw BIP-39 entropy of the root account — 16 or 32
 * bytes, *not* the 64-byte PBKDF2 seed. Terminal never sees it: the host applies
 * layer 1 during the SSO handshake and sends only the 32-byte result.
 *
 * The scheme has parallel implementations in five languages — host-container
 * (TS), host-encoding (Rust, canonical), sdk-swift, sdk-android and
 * brevity-flutter (Dart) — so the shared artifact is the spec rather than a
 * package: Swift, Kotlin and Dart cannot import a TS one. The safety net is the
 * cross-language conformance suite, which the tests below pin against verbatim.
 * Cite the spec, not any one implementation: mirrors drift.
 *
 * A follow-up lifts the two halves into their canonical homes without changing
 * behaviour: `blake2b256Keyed` into `@parity/product-sdk-crypto` (the missing
 * sibling of the `blake2b256` already there) and the pure derivation into
 * `@parity/product-sdk-keys`, beside `product-account.ts`. The session wrapper
 * below stays exactly as it is.
 *
 * @module
 */

import { blake2b } from "@noble/hashes/blake2.js";
// Used only by the in-source tests below; treeshaken out of the published build.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { UserSession } from "@novasamatech/host-papp";

/**
 * Length of `rootEntropySource` — layer 1's *output*, always a 32-byte
 * blake2b256 digest. Not to be confused with the raw BIP-39 root entropy that
 * feeds layer 1, which is 16 or 32 bytes.
 */
const ROOT_ENTROPY_SOURCE_LEN = 32;
const MAX_KEY_LEN = 32;
const textEncoder = new TextEncoder();

/** BLAKE2b-256, optionally keyed — the RFC-0007 primitive. */
const b2 = (message: Uint8Array, key?: Uint8Array): Uint8Array =>
    key ? blake2b(message, { dkLen: 32, key }) : blake2b(message, { dkLen: 32 });

/**
 * Derive 32 bytes of deterministic entropy for a terminal session, scoped to the
 * calling product and a caller key (RFC-0007 layers 2 + 3).
 *
 * Same wallet + product + key ⇒ same bytes; any difference ⇒ uncorrelated
 * entropy. Because it derives from the wallet (not the device), the entropy is
 * recreatable after device loss as long as the wallet is recoverable.
 *
 * @param session   - A QR-paired {@link UserSession}. Must carry
 *   `rootEntropySource` (present since host-papp 0.8.6 / RFC-0007).
 * @param productId - The calling product's identifier, used verbatim as the
 *   layer-2 scope. Per host-spec §C.7 that is `<label>.dot` for a dotNS product
 *   (e.g. `"my-app.dot"`), or `localhost:<port>` — no `.dot` suffix — for local
 *   dev. It is case-sensitive and is **not** normalized here: `"My-App.dot"`,
 *   `"my-app.dot "` and `"my-app.dot"` derive three uncorrelated entropies.
 *
 *   This must be the identifier the *in-container* deployment is served under —
 *   the same value you pass as `productId` to `getBulletinSigner` — because
 *   that is the scope the host derives against. It is **not** `adapter.appId`:
 *   the adapter id is a local namespace (cache keys, storage dir) and the two
 *   are routinely different. The package's own example pairs
 *   `createTerminalAdapter({ appId: "my-cli" })` with
 *   `getBulletinSigner(adapter, "my-cli.dot")`. Note that
 *   `requestResourceAllocation` takes no `productId` and forwards
 *   `adapter.appId` as the calling product id, so it is *not* a reliable
 *   reference point for this argument.
 *
 *   The host takes the scope from the iframe's deployment label rather than
 *   from the caller, so it differs per deployment: production, each PR preview
 *   and local dev all scope to different entropy. A CLI that hardcodes the
 *   production id derives valid-but-different bytes against a preview, with no
 *   error anywhere.
 *
 *   Required and positional **by design** — do not give this a default. Unlike
 *   an allocation request, a wrong product scope here fails silently: it yields
 *   well-formed entropy that simply cannot decrypt anything.
 * @param key       - Caller key, 1..32 bytes (the layer-3 BLAKE2b key). Both
 *   bounds are normative: the spec requires zero-length and >32-byte keys to be
 *   rejected, because some BLAKE2b implementations silently degrade an empty MAC
 *   key to unkeyed mode.
 * @returns 32 bytes of derived entropy.
 * @throws if the session lacks `rootEntropySource` or carries one of the wrong
 *   width, if `productId` is not a non-empty string, or if `key` is not 1..32
 *   bytes.
 *
 * @remarks
 * This reads nothing account-identifying, and a terminal may hold several paired
 * sessions (see `waitForSessions`). Passing the wrong one yields valid entropy
 * for a *different* wallet: the intended user cannot decrypt, and the other
 * wallet's holder can. Pin the identity with `sessionRootPublicKey` before
 * deriving long-lived keys.
 *
 * The return value is raw key material — do not log it or persist it unwrapped.
 */
export function deriveEntropy(
    session: UserSession,
    productId: string,
    key: Uint8Array,
): Uint8Array {
    // host-papp types `rootEntropySource` as required, but V1 sessions persisted
    // before RFC-0007 have no such field. The widening annotation keeps the
    // runtime guard below reachable without an `as` cast, so an upstream *rename*
    // still fails to compile here. Same reasoning as `sessionRootPublicKey`.
    const rootEntropySource: Uint8Array | undefined = session.rootEntropySource;
    if (!rootEntropySource) {
        throw new Error(
            'deriveEntropy: stored login session is missing rootEntropySource. Run "logout" and then "login" to pair again with an RFC-0007 host.',
        );
    }
    if (rootEntropySource.length !== ROOT_ENTROPY_SOURCE_LEN) {
        throw new Error(
            `deriveEntropy: rootEntropySource must be ${ROOT_ENTROPY_SOURCE_LEN} bytes, got ${rootEntropySource.length}. The session is corrupt or the host emitted a non-conforming width; re-pairing will not help if the host is at fault.`,
        );
    }
    if (typeof productId !== "string" || productId.length === 0) {
        // Cheap guard for untyped JS consumers: `undefined`/`null` would other-
        // wise stringify and silently scope entropy to "undefined" / "null".
        throw new Error(
            `deriveEntropy: productId must be a non-empty string, got ${typeof productId === "string" ? "an empty string" : String(productId)}`,
        );
    }
    if (key.length === 0 || key.length > MAX_KEY_LEN) {
        throw new Error(`deriveEntropy: key must be 1..${MAX_KEY_LEN} bytes, got ${key.length}`);
    }
    const perProduct = b2(rootEntropySource, b2(textEncoder.encode(productId)));
    return b2(perProduct, key);
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("deriveEntropy", () => {
        // Use @noble's codecs rather than hand-rolled ones: they throw on
        // odd-length or non-hex input, so a mistyped vector below fails loudly
        // instead of silently degrading into different-but-valid test input.
        const unhex = hexToBytes;
        const toHex = bytesToHex;
        const sessionOf = (rootEntropySource: Uint8Array) =>
            ({ rootEntropySource }) as unknown as UserSession;
        /** RFC-0007 layer 1 — applied by the host during the SSO handshake. */
        const rootSourceOf = (rootAccountSecret: Uint8Array) =>
            b2(rootAccountSecret, textEncoder.encode("product-entropy-derivation"));

        const rootEntropySource = new Uint8Array(32).fill(1);
        const session = sessionOf(rootEntropySource);

        /**
         * Verbatim from the canonical cross-language conformance suite:
         * useragent-kit@92641ed `conformance/rfc0007-product-entropy-v1.json`.
         * Shared byte-for-byte with host-encoding (Rust, canonical), sdk-android
         * and sdk-swift — so these pin us against Rust and Kotlin/Swift rather
         * than against a single TS package.
         *
         * `rootEntropy` is the raw BIP-39 entropy (layer-1 *input*), so each
         * case applies layer 1 first to reach what a session actually carries.
         */
        const CONFORMANCE = [
            {
                name: "kotlin-anchor-my-key",
                rootEntropy: "abababababababababababababababab",
                productId: "test.product.dot",
                key: "6d792d6b6579",
                entropy: "479d5b9ecce19615397c9f160ee95e2f00c579837a5afb111132dd0da5fd472a",
            },
            {
                name: "kotlin-anchor-other-key",
                rootEntropy: "abababababababababababababababab",
                productId: "test.product.dot",
                key: "6f746865722d6b6579",
                entropy: "0d576d5d77cb179bf94b85cb1d644b7879315e74d9e69791fb9cbe94df3c7c39",
            },
            {
                name: "kotlin-anchor-other-product",
                rootEntropy: "abababababababababababababababab",
                productId: "other.product.dot",
                key: "6d792d6b6579",
                entropy: "e2f25271c106593c2977d5965f52fa1d2227da0fc110d682c8cb8f30b2ba21c8",
            },
            {
                name: "zero-root-16-bytes",
                rootEntropy: "00000000000000000000000000000000",
                productId: "chat.parity.dot",
                key: "01",
                entropy: "85bd2b21f8b7649e2936d589c3b90e0c31a3a6b45c8972cccaca6b99195dcf1c",
            },
            {
                name: "root-32-bytes",
                rootEntropy: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
                productId: "test.product.dot",
                key: "6d792d6b6579",
                entropy: "fd6d7466fe5d2bbe1338092db099228922b10b057471420fc12c6fa4f0439085",
            },
            {
                name: "single-byte-key",
                rootEntropy: "abababababababababababababababab",
                productId: "test.product.dot",
                key: "00",
                entropy: "1a94d3b75e32380d314fd0a0f4351341b923f80d30f34c17167cc11065c48230",
            },
            {
                name: "max-key-32-bytes",
                rootEntropy: "abababababababababababababababab",
                productId: "test.product.dot",
                key: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                entropy: "d57049728abd81f625ecc8221d6ea0fbfa241ae19cce3ae25003f6228c1944c3",
            },
            {
                name: "binary-key",
                rootEntropy: "abababababababababababababababab",
                productId: "test.product.dot",
                key: "deadbeef",
                entropy: "892f45ae549a218fba05278142db26abcf137009ef04e0b6bc212a2596727525",
            },
        ];

        test.each(CONFORMANCE)(
            "RFC-0007 conformance vector: $name",
            ({ rootEntropy, productId, key, entropy }) => {
                const s = sessionOf(rootSourceOf(unhex(rootEntropy)));
                expect(toHex(deriveEntropy(s, productId, unhex(key)))).toBe(entropy);
            },
        );

        test("pins layers 2 + 3 from a rootEntropySource (golden vector)", () => {
            // Documents the expected bytes for the exact shape terminal sees: a
            // session-supplied rootEntropySource, with no layer-1 step.
            expect(toHex(deriveEntropy(session, "my-app.dot", new Uint8Array([1, 2, 3, 4])))).toBe(
                "993750d5f3f4b941cef5a8084fdd0bcd6a6946fdc0e1fe87c0c575fe65e7dc03",
            );
        });

        test("is 32 bytes, deterministic, and product- and key-scoped", () => {
            const key = new Uint8Array([1, 2, 3, 4]);
            const a = deriveEntropy(session, "my-app.dot", key);
            expect(a).toHaveLength(32);
            expect(deriveEntropy(session, "my-app.dot", key)).toStrictEqual(a);
            expect(deriveEntropy(session, "other.dot", key)).not.toStrictEqual(a);
            expect(deriveEntropy(session, "my-app.dot", new Uint8Array([9]))).not.toStrictEqual(a);
        });

        test("treats productId verbatim — no case or whitespace normalization", () => {
            const key = new Uint8Array([1, 2, 3, 4]);
            const a = deriveEntropy(session, "my-app.dot", key);
            expect(deriveEntropy(session, "My-App.dot", key)).not.toStrictEqual(a);
            expect(deriveEntropy(session, "my-app.dot ", key)).not.toStrictEqual(a);
        });

        test("different root entropy yields uncorrelated entropy", () => {
            const other = sessionOf(new Uint8Array(32).fill(2));
            const key = new Uint8Array([1, 2, 3, 4]);
            expect(deriveEntropy(other, "my-app.dot", key)).not.toStrictEqual(
                deriveEntropy(session, "my-app.dot", key),
            );
        });

        test("accepts both key-length bounds", () => {
            // Guards the guard: an off-by-one to `key.length >= MAX_KEY_LEN`
            // would still pass every rejection test above, while wrongly
            // rejecting the 32-byte key the spec explicitly allows.
            expect(deriveEntropy(session, "my-app.dot", new Uint8Array(1))).toHaveLength(32);
            expect(deriveEntropy(session, "my-app.dot", new Uint8Array(MAX_KEY_LEN))).toHaveLength(
                32,
            );
        });

        test("rejects a key outside 1..32 bytes", () => {
            // Both rejections are normative (conformance suite `invalid` cases
            // `key-empty` and `key-exceeds-max`); @noble would accept keys up to
            // 64 bytes, so the upper bound is enforced here or nowhere.
            expect(() => deriveEntropy(session, "my-app.dot", new Uint8Array(0))).toThrow(
                /1\.\.32/,
            );
            expect(() => deriveEntropy(session, "my-app.dot", new Uint8Array(33))).toThrow(
                /1\.\.32/,
            );
        });

        test("throws when the session has no rootEntropySource", () => {
            expect(() =>
                deriveEntropy({} as UserSession, "my-app.dot", new Uint8Array([1])),
            ).toThrow(/rootEntropySource/);
        });

        test("distinguishes a wrong-length rootEntropySource from a missing one", () => {
            // Different remediation: re-pairing fixes a stale session, but not a
            // host emitting a non-conforming width.
            expect(() =>
                deriveEntropy(sessionOf(new Uint8Array(16)), "my-app.dot", new Uint8Array([1])),
            ).toThrow(/must be 32 bytes, got 16/);
            expect(() =>
                deriveEntropy({} as UserSession, "my-app.dot", new Uint8Array([1])),
            ).toThrow(/logout/);
        });

        test("rejects an empty or non-string productId", () => {
            // A wrong product scope fails silently, so the cheap cases are
            // caught here rather than surfacing as undecryptable data later.
            expect(() => deriveEntropy(session, "", new Uint8Array([1]))).toThrow(/non-empty/);
            expect(() =>
                deriveEntropy(session, undefined as unknown as string, new Uint8Array([1])),
            ).toThrow(/non-empty/);
        });
    });
}
