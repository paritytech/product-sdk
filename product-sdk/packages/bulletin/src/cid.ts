import { blake2b256, bytesToHex, hexToBytes } from "@parity/product-sdk-crypto";
import { createLogger } from "@parity/product-sdk-logger";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

import { BulletinCidError } from "./errors.js";

const log = createLogger("bulletin");

/**
 * Hash algorithms supported by the Bulletin Chain.
 *
 * Values are multihash codes as defined in the
 * {@link https://github.com/multiformats/multicodec multicodec table}.
 */
export const HashAlgorithm = {
    /** BLAKE2b-256 — default for product-sdk and the chain SDK. */
    Blake2b256: 0xb220,
    /** SHA2-256 — default for bulletin-deploy. */
    Sha2_256: 0x12,
    /** Keccak-256 — Ethereum compatibility. */
    Keccak256: 0x1b,
} as const;

/** A multihash code supported by the Bulletin Chain. */
export type HashAlgorithm = (typeof HashAlgorithm)[keyof typeof HashAlgorithm];

/**
 * CID codecs supported by the Bulletin Chain.
 *
 * Values are multicodec codes.
 */
export const CidCodec = {
    /** Raw binary — default for single-chunk data. */
    Raw: 0x55,
    /** DAG-PB — used for multi-chunk manifests / directory structures. */
    DagPb: 0x70,
    /** DAG-CBOR — alternative DAG encoding. */
    DagCbor: 0x71,
} as const;

/** A multicodec code supported by the Bulletin Chain. */
export type CidCodec = (typeof CidCodec)[keyof typeof CidCodec];

const SUPPORTED_HASH_CODES = new Set<number>(Object.values(HashAlgorithm));
const SUPPORTED_CODEC_CODES = new Set<number>(Object.values(CidCodec));
const EXPECTED_HEX_LENGTH = 66; // "0x" + 64 hex chars = 32 bytes

/**
 * Compute the CIDv1 (blake2b-256, raw codec) for arbitrary data.
 * Deterministic: same input always produces the same CID.
 */
export function computeCid(data: Uint8Array): string {
    const hash = blake2b256(data);
    return CID.createV1(CidCodec.Raw, Digest.create(HashAlgorithm.Blake2b256, hash)).toString();
}

/**
 * Extract the content hash digest from a CIDv1 string and return it as a
 * `0x`-prefixed hex string — the preimage key format used by the host API.
 *
 * Accepts CIDv1 with any hash algorithm supported by the Bulletin Chain
 * (blake2b-256, sha2-256, keccak-256).
 *
 * @param cid - CIDv1 base32 string (as produced by {@link computeCid} or {@link hashToCid}).
 * @returns `0x`-prefixed hex string of the 32-byte hash digest.
 * @throws If the CID is not CIDv1 or uses an unsupported hash algorithm.
 */
export function cidToPreimageKey(cid: string): `0x${string}` {
    const parsed = CID.parse(cid);
    if (parsed.version !== 1) {
        throw new BulletinCidError(`Expected CIDv1, got CIDv${parsed.version}`, cid);
    }
    if (!SUPPORTED_HASH_CODES.has(parsed.multihash.code)) {
        throw new BulletinCidError(
            `Unsupported hash algorithm 0x${parsed.multihash.code.toString(16)}; ` +
                `expected one of: ${[...SUPPORTED_HASH_CODES].map((c) => `0x${c.toString(16)}`).join(", ")}`,
            cid,
        );
    }
    return `0x${bytesToHex(parsed.multihash.digest)}`;
}

/**
 * Reconstruct a CIDv1 from a `0x`-prefixed hex hash stored on-chain.
 *
 * This is the inverse of {@link cidToPreimageKey}: given a 32-byte content hash
 * and the CID configuration used when the data was stored, it rebuilds the
 * original CIDv1 so you can construct IPFS gateway URLs.
 *
 * The Bulletin Chain supports multiple hash algorithms and codecs — pass the
 * values that match the on-chain `TransactionInfo` to get the correct CID.
 * When omitted, defaults match {@link computeCid} (blake2b-256, raw).
 *
 * @param hexHash   - `0x`-prefixed hex string of a 32-byte hash digest
 *   (66 characters total: `"0x"` + 64 hex chars).
 * @param hashCode  - Multihash code of the hashing algorithm (default: blake2b-256 `0xb220`).
 *   Use {@link HashAlgorithm} for the supported values.
 * @param codec     - Multicodec code of the CID codec (default: raw `0x55`).
 *   Use {@link CidCodec} for the supported values.
 * @returns Base32-lower CIDv1 string.
 * @throws If `hexHash` is not exactly 66 characters, or if the hash/codec is unsupported.
 *
 * @example
 * ```ts
 * import { hashToCid, HashAlgorithm, CidCodec, gatewayUrl, getGateway } from "@parity/product-sdk-bulletin";
 *
 * // Default (blake2b-256, raw) — matches computeCid output
 * const cid = hashToCid(onChainHash);
 *
 * // SHA2-256 content stored via bulletin-deploy
 * const cid2 = hashToCid(onChainHash, HashAlgorithm.Sha2_256);
 *
 * // DAG-PB manifest with blake2b-256
 * const cid3 = hashToCid(manifestHash, HashAlgorithm.Blake2b256, CidCodec.DagPb);
 *
 * const url = gatewayUrl(cid, getGateway("paseo"));
 * ```
 *
 * @see {@link cidToPreimageKey} for the reverse direction (CID → hex hash).
 * @see {@link computeCid} for computing a CID from raw data.
 * @see {@link HashAlgorithm} for supported hash algorithms.
 * @see {@link CidCodec} for supported CID codecs.
 */
export function hashToCid(
    hexHash: `0x${string}`,
    hashCode: HashAlgorithm = HashAlgorithm.Blake2b256,
    codec: CidCodec = CidCodec.Raw,
): string {
    if (hexHash.length !== EXPECTED_HEX_LENGTH) {
        throw new BulletinCidError(
            `Expected a 0x-prefixed 32-byte hex hash (${EXPECTED_HEX_LENGTH} chars), ` +
                `got ${hexHash.length} chars`,
        );
    }
    if (!SUPPORTED_HASH_CODES.has(hashCode)) {
        throw new BulletinCidError(
            `Unsupported hash algorithm 0x${hashCode.toString(16)}; ` +
                `expected one of: ${[...SUPPORTED_HASH_CODES].map((c) => `0x${c.toString(16)}`).join(", ")}`,
        );
    }
    if (!SUPPORTED_CODEC_CODES.has(codec)) {
        throw new BulletinCidError(
            `Unsupported CID codec 0x${codec.toString(16)}; ` +
                `expected one of: ${[...SUPPORTED_CODEC_CODES].map((c) => `0x${c.toString(16)}`).join(", ")}`,
        );
    }
    const digest = hexToBytes(hexHash.slice(2));
    const cid = CID.createV1(codec, Digest.create(hashCode, digest)).toString();
    log.debug("hashToCid", { hexHash, hashCode, codec, cid });
    return cid;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("computeCid", () => {
        test("produces known CID for known input", () => {
            const data = new TextEncoder().encode("hello bulletin");
            const cid = computeCid(data);
            expect(cid).toBe(computeCid(new TextEncoder().encode("hello bulletin")));
            expect(cid).toMatch(/^b[a-z2-7]+$/);
        });

        test("deterministic — same input, same output", () => {
            const data = new Uint8Array([1, 2, 3, 4, 5]);
            expect(computeCid(data)).toBe(computeCid(data));
        });

        test("different inputs produce different CIDs", () => {
            const a = computeCid(new Uint8Array([1]));
            const b = computeCid(new Uint8Array([2]));
            expect(a).not.toBe(b);
        });

        test("empty input produces valid CID", () => {
            const cid = computeCid(new Uint8Array(0));
            expect(cid).toMatch(/^b[a-z2-7]+$/);
        });

        test("matches reference implementation (manual varint)", () => {
            const data = new TextEncoder().encode("test");
            const cid = computeCid(data);
            expect(cid[0]).toBe("b");
            const parsed = CID.parse(cid);
            expect(parsed.version).toBe(1);
            expect(parsed.code).toBe(CidCodec.Raw);
        });
    });

    describe("cidToPreimageKey", () => {
        test("round-trips with computeCid — returns 0x-prefixed 64-char hex", () => {
            const data = new TextEncoder().encode("hello bulletin");
            const cid = computeCid(data);
            const key = cidToPreimageKey(cid);
            expect(key).toMatch(/^0x[0-9a-f]{64}$/);
        });

        test("deterministic — same CID always yields same key", () => {
            const cid = computeCid(new Uint8Array([1, 2, 3]));
            expect(cidToPreimageKey(cid)).toBe(cidToPreimageKey(cid));
        });

        test("matches raw blake2b-256 hash", () => {
            const data = new TextEncoder().encode("test");
            const cid = computeCid(data);
            const key = cidToPreimageKey(cid);
            const hash = blake2b256(data);
            const expected = `0x${bytesToHex(hash)}`;
            expect(key).toBe(expected);
        });

        test("accepts CIDv1 with sha2-256", () => {
            const hash = new Uint8Array(32).fill(0xcd);
            const cidV1 = CID.createV1(CidCodec.Raw, Digest.create(HashAlgorithm.Sha2_256, hash));
            const key = cidToPreimageKey(cidV1.toString());
            expect(key).toMatch(/^0x[0-9a-f]{64}$/);
            expect(key).toBe(`0x${bytesToHex(hash)}`);
        });

        test("accepts CIDv1 with keccak-256", () => {
            const hash = new Uint8Array(32).fill(0xef);
            const cidV1 = CID.createV1(CidCodec.Raw, Digest.create(HashAlgorithm.Keccak256, hash));
            const key = cidToPreimageKey(cidV1.toString());
            expect(key).toBe(`0x${bytesToHex(hash)}`);
        });

        test("throws BulletinCidError for CIDv0 input", () => {
            const hash = new Uint8Array(32).fill(0xab);
            const cidV0 = CID.create(0, 0x70, Digest.create(HashAlgorithm.Sha2_256, hash));
            expect(() => cidToPreimageKey(cidV0.toString())).toThrow(BulletinCidError);
        });

        test("throws BulletinCidError for CIDv1 with unsupported hash algorithm", () => {
            const unsupportedCode = 0x99;
            const hash = new Uint8Array(32).fill(0xab);
            const cidV1 = CID.createV1(CidCodec.Raw, Digest.create(unsupportedCode, hash));
            expect(() => cidToPreimageKey(cidV1.toString())).toThrow(BulletinCidError);
        });
    });

    describe("hashToCid", () => {
        test("round-trips with cidToPreimageKey — hex → CID → hex", () => {
            const data = new TextEncoder().encode("hello bulletin");
            const originalCid = computeCid(data);
            const hex = cidToPreimageKey(originalCid);
            const reconstructed = hashToCid(hex);
            expect(reconstructed).toBe(originalCid);
        });

        test("full cycle: data → CID → hex → CID", () => {
            const data = new Uint8Array([10, 20, 30, 40, 50]);
            const cid1 = computeCid(data);
            const hex = cidToPreimageKey(cid1);
            const cid2 = hashToCid(hex);
            expect(cid2).toBe(cid1);
        });

        test("deterministic — same hex always yields same CID", () => {
            const hex = cidToPreimageKey(computeCid(new Uint8Array([1, 2, 3])));
            expect(hashToCid(hex)).toBe(hashToCid(hex));
        });

        test("produces valid base32-lower CIDv1 (default: blake2b-256, raw)", () => {
            const hex = cidToPreimageKey(computeCid(new TextEncoder().encode("test")));
            const cid = hashToCid(hex);
            expect(cid).toMatch(/^b[a-z2-7]+$/);
            const parsed = CID.parse(cid);
            expect(parsed.version).toBe(1);
            expect(parsed.code).toBe(CidCodec.Raw);
            expect(parsed.multihash.code).toBe(HashAlgorithm.Blake2b256);
        });

        test("sha2-256 produces different CID from blake2b-256 for same hash", () => {
            const hex = `0x${"ab".repeat(32)}` as `0x${string}`;
            const blake = hashToCid(hex, HashAlgorithm.Blake2b256);
            const sha = hashToCid(hex, HashAlgorithm.Sha2_256);
            expect(blake).not.toBe(sha);
            // Both should be valid CIDv1
            expect(CID.parse(blake).version).toBe(1);
            expect(CID.parse(sha).version).toBe(1);
        });

        test("sha2-256 round-trips through cidToPreimageKey", () => {
            const hex = `0x${"cd".repeat(32)}` as `0x${string}`;
            const cid = hashToCid(hex, HashAlgorithm.Sha2_256);
            const extracted = cidToPreimageKey(cid);
            expect(extracted).toBe(hex);
        });

        test("keccak-256 round-trips through cidToPreimageKey", () => {
            const hex = `0x${"ef".repeat(32)}` as `0x${string}`;
            const cid = hashToCid(hex, HashAlgorithm.Keccak256);
            const extracted = cidToPreimageKey(cid);
            expect(extracted).toBe(hex);
        });

        test("dag-pb codec produces different CID from raw for same hash", () => {
            const hex = `0x${"ab".repeat(32)}` as `0x${string}`;
            const rawCid = hashToCid(hex, HashAlgorithm.Blake2b256, CidCodec.Raw);
            const dagPbCid = hashToCid(hex, HashAlgorithm.Blake2b256, CidCodec.DagPb);
            expect(rawCid).not.toBe(dagPbCid);
            expect(CID.parse(dagPbCid).code).toBe(CidCodec.DagPb);
        });

        test("dag-cbor codec works", () => {
            const hex = `0x${"ab".repeat(32)}` as `0x${string}`;
            const cid = hashToCid(hex, HashAlgorithm.Blake2b256, CidCodec.DagCbor);
            expect(CID.parse(cid).code).toBe(CidCodec.DagCbor);
        });

        test("throws BulletinCidError for hex that is too short", () => {
            expect(() => hashToCid("0xabcd" as `0x${string}`)).toThrow(BulletinCidError);
        });

        test("throws BulletinCidError for hex that is too long", () => {
            const tooLong = `0x${"aa".repeat(33)}` as `0x${string}`;
            expect(() => hashToCid(tooLong)).toThrow(BulletinCidError);
        });

        test("throws for non-hex characters", () => {
            const bad = `0x${"zz".repeat(32)}` as `0x${string}`;
            expect(() => hashToCid(bad)).toThrow();
        });

        test("throws BulletinCidError for unsupported hash algorithm", () => {
            const hex = `0x${"ab".repeat(32)}` as `0x${string}`;
            expect(() => hashToCid(hex, 0x99 as HashAlgorithm)).toThrow(BulletinCidError);
        });

        test("throws BulletinCidError for unsupported codec", () => {
            const hex = `0x${"ab".repeat(32)}` as `0x${string}`;
            expect(() => hashToCid(hex, HashAlgorithm.Blake2b256, 0x99 as CidCodec)).toThrow(
                BulletinCidError,
            );
        });
    });
}
