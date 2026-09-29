// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Development helpers for `@parity/product-sdk-individuality`, for scripts and
 * tests that hold a key, never for a product running under a host.
 *
 * `localAirdropVrfSigner` mints the airdrop VRFs of a game sign-up from an sr25519
 * secret key in memory, so a script can call `mintAccountAirdropVrfs` with no host.
 * A hosted product signs through the host, which never hands out the key.
 *
 * ```ts
 * import { getPublicKey } from "@scure/sr25519";
 * import { mintAccountAirdropVrfs } from "@parity/product-sdk-individuality";
 * import { localAirdropVrfSigner } from "@parity/product-sdk-individuality/testing";
 *
 * const vrfs = await mintAccountAirdropVrfs(localAirdropVrfSigner(secretKey), {
 *     eventIds,
 *     publicKey: getPublicKey(secretKey),
 * });
 * ```
 *
 * @packageDocumentation
 */
import { mod } from "@noble/curves/abstract/modular.js";
import { ed25519, ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import {
    bytesToNumberLE,
    concatBytes,
    equalBytes,
    numberToBytesLE,
    randomBytes,
} from "@noble/curves/utils.js";
import { __tests, getPublicKey } from "@scure/sr25519";
import { ProductIndividualityError } from "./errors.js";
import type { AirdropVrfSigner } from "./signup.js";
import type { VrfTranscript } from "./signup-vrf.js";

const { SigningContext } = __tests;
const RistrettoPoint = ristretto255.Point;
type Point = InstanceType<typeof RistrettoPoint>;
type Transcript = InstanceType<typeof SigningContext>;
const CURVE_ORDER = ed25519.Point.Fn.ORDER;
const SECRET_KEY_BYTES = 64;
const PRE_OUTPUT_BYTES = 32;
const SIGNER_LABEL = new TextEncoder().encode("signer");

/**
 * An {@link AirdropVrfSigner} over an sr25519 secret key held in memory.
 *
 * @param secretKey - the 64-byte expanded key, scalar then nonce, as
 *   `secretFromSeed` from `@scure/sr25519` returns it.
 * @throws ProductIndividualityError on a key of the wrong length, and from
 *   `signVrf` when the transcript names a signer other than this key, which would
 *   verify against nothing.
 */
export function localAirdropVrfSigner(secretKey: Uint8Array): AirdropVrfSigner {
    if (secretKey.length !== SECRET_KEY_BYTES) {
        throw new ProductIndividualityError(`sr25519 secret key must be ${SECRET_KEY_BYTES} bytes`);
    }
    const key = Uint8Array.from(secretKey);
    const publicKey = getPublicKey(key);
    const publicPoint = RistrettoPoint.fromBytes(publicKey);
    return {
        async signVrf(label, items) {
            const signer = items.find((item) => equalBytes(item.label, SIGNER_LABEL));
            if (signer !== undefined && !equalBytes(signer.value, publicKey)) {
                throw new ProductIndividualityError(
                    "the VRF transcript names a signer other than this key",
                );
            }
            const signature = sr25519VrfSign(key, publicPoint, { label, items });
            return {
                preOutput: signature.slice(0, PRE_OUTPUT_BYTES),
                proof: signature.slice(PRE_OUTPUT_BYTES),
            };
        },
    };
}

/** schnorrkel stores the scalar times the cofactor, so it is divided back out. */
const decodeScalar = (bytes: Uint8Array) => bytesToNumberLE(bytes) >> 3n;

/**
 * schnorrkel `vrf_create_hash`. The transcript is built by hand because `vrf.sign`
 * from `@scure/sr25519` hardcodes the `SigningContext` label and the `sign-bytes`
 * item, and the airdrop pallet verifies against its own label and items.
 */
function vrfInput(spec: VrfTranscript, publicPoint: Point): Point {
    // Merlin takes the label as bytes, whatever the constructor typing says.
    const transcript = new SigningContext(spec.label as unknown as string);
    for (const item of spec.items) {
        transcript.appendMessage(item.label, item.value);
    }
    transcript.commitPoint("vrf-nm-pk", publicPoint);
    const hash = transcript.challengeBytes("VRFHash", 64);
    transcript.clean();
    const deriveToCurve = ristretto255_hasher.deriveToCurve;
    if (deriveToCurve === undefined) {
        throw new ProductIndividualityError("ristretto255 hash-to-curve is unavailable");
    }
    return deriveToCurve(hash);
}

/** The fresh transcript the DLEQ proof runs on, up to the witness. */
function dleqTranscript(input: Point): Transcript {
    const dleq = new SigningContext("VRF");
    dleq.protoName("DLEQProof");
    dleq.commitPoint("vrf:h", input);
    return dleq;
}

/** The DLEQ challenge, over the same commitments whether proving or verifying. */
function dleqChallenge(
    dleq: Transcript,
    commitments: { r: Point; hr: Point; publicPoint: Point; output: Point },
): bigint {
    dleq.commitPoint("vrf:R=g^r", commitments.r);
    dleq.commitPoint("vrf:h^r", commitments.hr);
    dleq.commitPoint("vrf:pk", commitments.publicPoint);
    dleq.commitPoint("vrf:h^sk", commitments.output);
    const c = dleq.challengeScalar("prove");
    dleq.clean();
    return c;
}

/**
 * A VRF signature `pre_output ++ c ++ s`, which is the SCALE encoding of
 * `sp_core::sr25519::vrf::VrfSignature`. The output depends on the key and the
 * transcript alone, and `random` only blinds the proof.
 */
function sr25519VrfSign(
    secretKey: Uint8Array,
    publicPoint: Point,
    spec: VrfTranscript,
    random: Uint8Array = randomBytes(32),
): Uint8Array {
    const keyScalar = decodeScalar(secretKey.subarray(0, 32));
    const input = vrfInput(spec, publicPoint);
    const output = input.multiply(keyScalar);
    const dleq = dleqTranscript(input);
    // schnorrkel labels the witness b"proving\00", a NUL byte then an ASCII zero.
    const r = dleq.witnessScalar("proving\u{0}0", random, [secretKey.subarray(32, 64)]);
    const c = dleqChallenge(dleq, {
        r: RistrettoPoint.BASE.multiply(r),
        hr: input.multiply(r),
        publicPoint,
        output,
    });
    const s = mod(r - c * keyScalar, CURVE_ORDER);
    return concatBytes(output.toBytes(), numberToBytesLE(c, 32), numberToBytesLE(s, 32));
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;
    const { secretFromSeed, vrf } = await import("@scure/sr25519");
    const { unwrapOk } = await import("@parity/result");
    const { mintAccountAirdropVrfs } = await import("./signup.js");
    const { airdropVrfTranscript } = await import("./signup-vrf.js");

    const sr25519VrfSignWith = (secretKey: Uint8Array, spec: VrfTranscript, random?: Uint8Array) =>
        sr25519VrfSign(secretKey, RistrettoPoint.fromBytes(getPublicKey(secretKey)), spec, random);

    /** The check the runtime runs, over the same transcript helpers. */
    function sr25519VrfVerify(
        publicKey: Uint8Array,
        spec: VrfTranscript,
        signature: Uint8Array,
    ): boolean {
        if (signature.length !== 96) return false;
        let publicPoint: Point;
        let output: Point;
        try {
            publicPoint = RistrettoPoint.fromBytes(publicKey);
            output = RistrettoPoint.fromBytes(signature.subarray(0, 32));
        } catch {
            return false;
        }
        if (publicPoint.equals(RistrettoPoint.ZERO)) return false;
        const c = bytesToNumberLE(signature.subarray(32, 64));
        const s = bytesToNumberLE(signature.subarray(64, 96));
        if (c >= CURVE_ORDER || s >= CURVE_ORDER) return false;
        const input = vrfInput(spec, publicPoint);
        const expected = dleqChallenge(dleqTranscript(input), {
            r: publicPoint.multiply(c).add(RistrettoPoint.BASE.multiply(s)),
            hr: output.multiply(c).add(input.multiply(s)),
            publicPoint,
            output,
        });
        return expected === c;
    }

    const bytes = (text: string) => new TextEncoder().encode(text);
    const seed = (byte: number) => new Uint8Array(32).fill(byte);
    const secret = secretFromSeed(seed(7));
    const other = secretFromSeed(seed(9));
    const random = new Uint8Array(32).fill(3);
    const EMPTY = new Uint8Array(0);

    const spec = (label: string, items: Array<[string, Uint8Array]>): VrfTranscript => ({
        label: bytes(label),
        items: items.map(([name, value]) => ({ label: bytes(name), value })),
    });

    const airdropLike = spec("pop:airdrop", [
        ["domain", new Uint8Array([1, 2, 3])],
        ["signer", getPublicKey(secret)],
    ]);

    describe("sr25519VrfSign", () => {
        test("produces a 96-byte pre_output, c and s that verifies", () => {
            const signature = sr25519VrfSignWith(secret, airdropLike, random);
            expect(signature).toHaveLength(96);
            expect(sr25519VrfVerify(getPublicKey(secret), airdropLike, signature)).toBe(true);
        });

        test("is deterministic in the output, not in the proof", () => {
            const a = sr25519VrfSignWith(secret, airdropLike, new Uint8Array(32).fill(1));
            const b = sr25519VrfSignWith(secret, airdropLike, new Uint8Array(32).fill(2));
            expect(a.subarray(0, 32)).toEqual(b.subarray(0, 32));
            expect(a.subarray(32)).not.toEqual(b.subarray(32));
        });

        test("binds the transcript label, the item names, their order and their values", () => {
            const base = sr25519VrfSignWith(secret, airdropLike, random).subarray(0, 32);
            const variants = [
                spec("pop:airdrop:other", [
                    ["domain", new Uint8Array([1, 2, 3])],
                    ["signer", getPublicKey(secret)],
                ]),
                spec("pop:airdrop", [
                    ["domain2", new Uint8Array([1, 2, 3])],
                    ["signer", getPublicKey(secret)],
                ]),
                spec("pop:airdrop", [
                    ["signer", getPublicKey(secret)],
                    ["domain", new Uint8Array([1, 2, 3])],
                ]),
                spec("pop:airdrop", [
                    ["domain", new Uint8Array([1, 2, 4])],
                    ["signer", getPublicKey(secret)],
                ]),
            ];
            for (const variant of variants) {
                expect(sr25519VrfSignWith(secret, variant, random).subarray(0, 32)).not.toEqual(
                    base,
                );
            }
        });

        test("rejects a signature from another key, a tampered one and a short one", () => {
            const signature = sr25519VrfSignWith(secret, airdropLike, random);
            expect(sr25519VrfVerify(getPublicKey(other), airdropLike, signature)).toBe(false);
            const tampered = Uint8Array.from(signature);
            tampered[70] = (tampered[70] ?? 0) ^ 0x01;
            expect(sr25519VrfVerify(getPublicKey(secret), airdropLike, tampered)).toBe(false);
            expect(
                sr25519VrfVerify(getPublicKey(secret), airdropLike, signature.subarray(0, 95)),
            ).toBe(false);
        });
    });

    // The load-bearing half. Self-consistency proves nothing about schnorrkel, so
    // the construction is pinned against the VRF of `@scure/sr25519` itself, over
    // the one transcript `vrf.sign` can express: label `SigningContext` with the
    // items `("", ctx)` and `("sign-bytes", msg)`.
    describe("agreement with the VRF of @scure/sr25519", () => {
        const ctx = bytes("some-context");
        const msg = bytes("some-message");
        const upstreamShape = spec("SigningContext", [
            ["", ctx],
            ["sign-bytes", msg],
        ]);

        test("a signature from here verifies upstream", () => {
            const ours = sr25519VrfSignWith(secret, upstreamShape, random);
            expect(vrf.verify(msg, ours, getPublicKey(secret), ctx)).toBe(true);
        });

        test("an upstream signature verifies here", () => {
            const theirs = vrf.sign(msg, secret, ctx, EMPTY);
            expect(sr25519VrfVerify(getPublicKey(secret), upstreamShape, theirs)).toBe(true);
        });

        test("both derive the same output for the same transcript", () => {
            const ours = sr25519VrfSignWith(secret, upstreamShape, random);
            const theirs = vrf.sign(msg, secret, ctx, EMPTY);
            expect(ours.subarray(0, 32)).toEqual(theirs.subarray(0, 32));
        });

        test("upstream cannot express the pallet transcript, which is why this exists", () => {
            const theirs = vrf.sign(msg, secret, ctx, EMPTY);
            expect(sr25519VrfVerify(getPublicKey(secret), airdropLike, theirs)).toBe(false);
        });
    });

    describe("localAirdropVrfSigner", () => {
        const EVENT_IDS = [`0x${"a1".repeat(32)}`, `0x${"b2".repeat(32)}`];

        test("mints one verifiable VRF per draw through mintAccountAirdropVrfs", async () => {
            const publicKey = getPublicKey(secret);
            const vrfs = unwrapOk(
                await mintAccountAirdropVrfs(localAirdropVrfSigner(secret), {
                    eventIds: EVENT_IDS,
                    publicKey,
                }),
            );
            expect(vrfs).toHaveLength(2);
            vrfs.forEach((signature, i) => {
                expect(signature.preOutput).toHaveLength(32);
                expect(signature.proof).toHaveLength(64);
                const transcript = airdropVrfTranscript({ eventId: EVENT_IDS[i] ?? "", publicKey });
                const joined = concatBytes(signature.preOutput, signature.proof);
                expect(sr25519VrfVerify(publicKey, transcript, joined)).toBe(true);
            });
            expect(vrfs[0]?.preOutput).not.toEqual(vrfs[1]?.preOutput);
        });

        test("refuses a transcript that names another signer", async () => {
            const transcript = airdropVrfTranscript({
                eventId: EVENT_IDS[0] ?? "",
                publicKey: getPublicKey(other),
            });
            await expect(
                localAirdropVrfSigner(secret).signVrf(transcript.label, transcript.items),
            ).rejects.toThrow(/another signer|other than this key/);
        });

        test("rejects a secret key of the wrong length", () => {
            expect(() => localAirdropVrfSigner(new Uint8Array(32))).toThrow(
                ProductIndividualityError,
            );
        });

        test("keeps its own copy of the key", async () => {
            const key = Uint8Array.from(secret);
            const signer = localAirdropVrfSigner(key);
            key.fill(0);
            const transcript = airdropVrfTranscript({
                eventId: EVENT_IDS[0] ?? "",
                publicKey: getPublicKey(secret),
            });
            await expect(signer.signVrf(transcript.label, transcript.items)).resolves.toBeDefined();
        });
    });
}
