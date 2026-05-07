/**
 * CID helpers for converting between on-chain hex hashes and CIDs.
 *
 * Upstream `@parity/bulletin-sdk` exposes `calculateCid` (data → CID),
 * `parseCid` (string → CID), `cidFromBytes` (full-encoded → CID), and
 * `cidToBytes` (CID → full-encoded). The helpers here add a thin layer
 * for the `0x`-prefixed hex shape that on-chain `TransactionInfo` uses,
 * so callers don't need to do the digest plumbing themselves.
 *
 * Both helpers default to the chain default (blake2b-256, raw codec).
 * Pass `HashAlgorithm` and `CidCodec` for other configurations
 * (sha2-256, dag-pb, etc.).
 */
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

import { BulletinCidError } from "./errors.js";

/**
 * Hash algorithms supported by the Bulletin Chain.
 *
 * Values are multihash codes from the multicodec table.
 */
export const HashAlgorithm = {
    /** BLAKE2b-256 — chain default. */
    Blake2b256: 0xb220,
    /** SHA2-256. */
    Sha2_256: 0x12,
    /** Keccak-256 — Ethereum compatibility. */
    Keccak256: 0x1b,
} as const;
export type HashAlgorithm = (typeof HashAlgorithm)[keyof typeof HashAlgorithm];

/**
 * CID codecs supported by the Bulletin Chain.
 */
export const CidCodec = {
    /** Raw binary — default for single-chunk data. */
    Raw: 0x55,
    /** DAG-PB — used for multi-chunk manifests / IPFS UnixFS. */
    DagPb: 0x70,
    /** DAG-CBOR — alternative DAG encoding. */
    DagCbor: 0x71,
} as const;
export type CidCodec = (typeof CidCodec)[keyof typeof CidCodec];

const SUPPORTED_HASH_CODES = new Set<number>(Object.values(HashAlgorithm));
const SUPPORTED_CODEC_CODES = new Set<number>(Object.values(CidCodec));
const EXPECTED_HEX_LENGTH = 66; // "0x" + 64 hex chars (32-byte digest)

/**
 * Reconstruct a CIDv1 from a `0x`-prefixed 32-byte hex hash.
 *
 * Useful when reading on-chain `TransactionInfo.content_hash` and you need
 * the CID to look up content via an IPFS gateway.
 *
 * @param hexHash  - 66-char `0x`-prefixed hex of a 32-byte digest.
 * @param hashCode - Multihash code (default: blake2b-256).
 * @param codec    - Multicodec code (default: raw).
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
    if (!/^0x[0-9a-fA-F]{64}$/.test(hexHash)) {
        throw new BulletinCidError(
            `Invalid hash format: expected 0x-prefixed 32-byte hex string, got: ${hexHash}`,
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
    const digest = hexToBytes(hexHash);
    return CID.createV1(codec, Digest.create(hashCode, digest)).toString();
}

/**
 * Extract the 32-byte content hash digest from a CIDv1 and return it as a
 * `0x`-prefixed hex string.
 *
 * Useful for matching a CID against on-chain `TransactionInfo.content_hash`.
 */
export function cidToPreimageKey(cid: string): `0x${string}` {
    let parsed;
    try {
        parsed = CID.parse(cid);
    } catch {
        throw new BulletinCidError(`Invalid CID: ${cid}`, cid);
    }
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
    return `0x${bytesToHex(parsed.multihash.digest)}` as `0x${string}`;
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
    }
    return out;
}

function bytesToHex(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i]!.toString(16).padStart(2, "0");
    }
    return s;
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("hashToCid", () => {
        const sampleHex = `0x${"ab".repeat(32)}` as `0x${string}`;

        test("produces valid base32-lower CIDv1 (default: blake2b-256, raw)", () => {
            const cid = hashToCid(sampleHex);
            expect(cid).toMatch(/^b[a-z2-7]+$/);
            const parsed = CID.parse(cid);
            expect(parsed.version).toBe(1);
            expect(parsed.code).toBe(CidCodec.Raw);
            expect(parsed.multihash.code).toBe(HashAlgorithm.Blake2b256);
        });

        test("supports sha2-256", () => {
            const cid = hashToCid(sampleHex, HashAlgorithm.Sha2_256);
            expect(CID.parse(cid).multihash.code).toBe(HashAlgorithm.Sha2_256);
        });

        test("supports dag-pb codec", () => {
            const cid = hashToCid(sampleHex, HashAlgorithm.Blake2b256, CidCodec.DagPb);
            expect(CID.parse(cid).code).toBe(CidCodec.DagPb);
        });

        test("throws on short hex", () => {
            expect(() => hashToCid("0xabcd" as `0x${string}`)).toThrow(BulletinCidError);
        });

        test("throws on long hex", () => {
            const tooLong = `0x${"aa".repeat(33)}` as `0x${string}`;
            expect(() => hashToCid(tooLong)).toThrow(BulletinCidError);
        });

        test("throws on non-hex characters", () => {
            const bad = `0x${"zz".repeat(32)}` as `0x${string}`;
            expect(() => hashToCid(bad)).toThrow(BulletinCidError);
        });

        test("throws on unsupported hash algorithm", () => {
            expect(() => hashToCid(sampleHex, 0x99 as HashAlgorithm)).toThrow(BulletinCidError);
        });

        test("throws on unsupported codec", () => {
            expect(() => hashToCid(sampleHex, HashAlgorithm.Blake2b256, 0x99 as CidCodec)).toThrow(
                BulletinCidError,
            );
        });
    });

    describe("cidToPreimageKey", () => {
        test("round-trip with hashToCid", () => {
            const hex = `0x${"cd".repeat(32)}` as `0x${string}`;
            const cid = hashToCid(hex);
            expect(cidToPreimageKey(cid)).toBe(hex);
        });

        test("round-trip with sha2-256", () => {
            const hex = `0x${"ef".repeat(32)}` as `0x${string}`;
            const cid = hashToCid(hex, HashAlgorithm.Sha2_256);
            expect(cidToPreimageKey(cid)).toBe(hex);
        });

        test("throws on invalid CID string", () => {
            expect(() => cidToPreimageKey("not-a-cid")).toThrow(BulletinCidError);
        });

        test("throws on CIDv0 input", () => {
            const hash = new Uint8Array(32).fill(0xab);
            const cidV0 = CID.create(0, 0x70, Digest.create(HashAlgorithm.Sha2_256, hash));
            expect(() => cidToPreimageKey(cidV0.toString())).toThrow(BulletinCidError);
        });

        test("throws on unsupported hash algorithm", () => {
            const hash = new Uint8Array(32).fill(0xab);
            const cidV1 = CID.createV1(CidCodec.Raw, Digest.create(0x99, hash));
            expect(() => cidToPreimageKey(cidV1.toString())).toThrow(BulletinCidError);
        });
    });
}
