// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `getVerifiedArtwork`, the bytes an `ImageRef` names, checked against it.
 *
 * An item's `image` metadata is a content address in one of two forms, an
 * ASCII CID or a bare 32-byte digest, and neither is the bytes. Wherever the
 * bytes come from, a gateway, the host preimage manager, a cache, they are only
 * the artwork if they hash to the digest the chain committed to. This read does
 * that check, and answers with the bytes only when it passes, so a caller never
 * renders what a gateway happened to return under that name.
 *
 * Where the bytes come from is the caller's choice, through an
 * {@link ArtworkSource}. Two are provided: {@link preimageSource} over the host
 * preimage manager, whose key is exactly the digest, and {@link gatewaySource}
 * over an IPFS gateway by CID. The package itself talks to neither.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { blake2b256, sha256 } from "@parity/product-sdk-utils";
import { ProductNftsError } from "./errors.js";
import type { ImageRef } from "./types.js";

/** Multihash codes this read can verify. */
const BLAKE2B_256 = 0xb220;
const SHA2_256 = 0x12;

/** Every catalogue CID seen so far is CIDv1 raw with a blake2b-256 multihash. */
const DEFAULT_MULTIHASH = BLAKE2B_256;
const RAW_CODEC = 0x55;

/** What an `image` metadata value names, once decoded. */
export interface ArtworkAddress {
    /** The CID, base32 lower case, built from the digest when the chain stored only that. */
    cid: string;
    /** The 32-byte content digest, `0x` prefixed. The Bulletin preimage key. */
    digest: `0x${string}`;
    /** The multihash code, which says how to hash the bytes back to the digest. */
    multihash: number;
}

/** Where the bytes for a digest come from. `null` when the source has nothing. */
export type ArtworkSource = (
    address: ArtworkAddress,
    signal?: AbortSignal,
) => Promise<Uint8Array | null>;

export interface GetVerifiedArtworkOptions {
    source: ArtworkSource;
    signal?: AbortSignal;
}

/**
 * The answer, on the `ok` channel whatever the bytes did.
 *
 * `Verified` is the only tag that carries bytes. `Missing` means the source had
 * nothing under that address. `Mismatch` means the source answered with bytes
 * that do not hash to the digest, which is the case this read exists for: they
 * are reported as absent rather than handed over. `Unreadable` means the
 * `ImageRef` itself could not be decoded into an address, which is a metadata
 * problem rather than a source one.
 */
export type VerifiedArtwork =
    | { tag: "Verified"; address: ArtworkAddress; bytes: Uint8Array }
    | { tag: "Missing"; address: ArtworkAddress }
    | { tag: "Mismatch"; address: ArtworkAddress }
    | { tag: "Unreadable" };

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Decode(input: string): Uint8Array | null {
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const char of input) {
        const index = B32.indexOf(char);
        if (index < 0) return null;
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

function base32Encode(bytes: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] | null {
    let result = 0;
    let shift = 0;
    for (let i = offset; i < bytes.length && shift < 32; i++) {
        const byte = bytes[i] as number;
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return [result >>> 0, i + 1];
        shift += 7;
    }
    return null;
}

function varint(value: number): number[] {
    const out: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
        out.push((rest & 0x7f) | 0x80);
        rest >>>= 7;
    }
    out.push(rest);
    return out;
}

function toHex(bytes: Uint8Array): `0x${string}` {
    let hex = "0x";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex as `0x${string}`;
}

function fromHex(hex: string): Uint8Array | null {
    const body = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** A CIDv1 raw string for a 32-byte digest, the form the catalogue CIDs take. */
function cidFor(digest: Uint8Array, multihash: number): string {
    const bytes = new Uint8Array([
        1,
        ...varint(RAW_CODEC),
        ...varint(multihash),
        ...varint(digest.length),
        ...digest,
    ]);
    return `b${base32Encode(bytes)}`;
}

/** A base32 CIDv1 with a 32-byte digest into an address, or `null` for anything else. */
function decodeCid(cid: string): ArtworkAddress | null {
    const bytes = base32Decode(cid.slice(1));
    if (bytes === null || bytes[0] !== 1) return null;
    const codec = readVarint(bytes, 1);
    if (codec === null) return null;
    const multihash = readVarint(bytes, codec[1]);
    if (multihash === null) return null;
    const length = readVarint(bytes, multihash[1]);
    if (length === null || length[0] !== 32 || bytes.length !== length[1] + 32) return null;
    return { cid, digest: toHex(bytes.subarray(length[1])), multihash: multihash[0] };
}

/**
 * Decode an `image` value into an address, whichever form the chain stored.
 *
 * `text` wins when it parses as a CIDv1 with a 32-byte digest, because it
 * carries the multihash code. Otherwise `hex` is taken as a blake2b-256 digest,
 * the only convention seen on a live deployment. `null` when neither reads.
 */
export function artworkAddress(image: ImageRef): ArtworkAddress | null {
    // Multibase allows `B` for upper-case base32, the same bytes.
    if (image.text?.startsWith("b") || image.text?.startsWith("B")) {
        const fromCid = decodeCid(`b${image.text.slice(1).toLowerCase()}`);
        if (fromCid !== null) return { ...fromCid, cid: image.text };
    }
    const digest = fromHex(image.hex);
    if (digest === null) return null;
    return {
        cid: cidFor(digest, DEFAULT_MULTIHASH),
        digest: toHex(digest),
        multihash: DEFAULT_MULTIHASH,
    };
}

/** Hash `bytes` the way the address says, or `null` for a multihash this read cannot. */
function digestOf(bytes: Uint8Array, multihash: number): Uint8Array | null {
    if (multihash === BLAKE2B_256) return blake2b256(bytes);
    if (multihash === SHA2_256) return sha256(bytes);
    return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
    return diff === 0;
}

/**
 * Fetch the bytes an `ImageRef` names and check them against its digest.
 *
 * Returns a `Result`. The four outcomes an address can have are all on the `ok`
 * channel, see {@link VerifiedArtwork}. The `err` channel is for a source that
 * threw or a signal that aborted.
 *
 * @example
 * ```ts
 * const manager = await getPreimageManager();
 * const art = await getVerifiedArtwork(item.imageRef, { source: preimageSource(manager) });
 * if (art.ok && art.value.tag === "Verified") {
 *     img.src = URL.createObjectURL(new Blob([art.value.bytes], { type: "image/webp" }));
 * }
 * ```
 */
export async function getVerifiedArtwork(
    image: ImageRef | null,
    options: GetVerifiedArtworkOptions,
): Promise<Result<VerifiedArtwork, ProductNftsError>> {
    try {
        options.signal?.throwIfAborted();
        const address = image === null ? null : artworkAddress(image);
        if (address === null) return ok({ tag: "Unreadable" });
        const bytes = await options.source(address, options.signal);
        if (bytes === null) return ok({ tag: "Missing", address });
        const expected = fromHex(address.digest) as Uint8Array;
        const actual = digestOf(bytes, address.multihash);
        if (actual === null || !sameBytes(actual, expected))
            return ok({ tag: "Mismatch", address });
        return ok({ tag: "Verified", address, bytes });
    } catch (cause) {
        return err(normalizeError(cause, ProductNftsError));
    }
}

/**
 * A source over the host preimage manager, keyed by the digest.
 *
 * On Bulletin the digest is the preimage key, so no CID round trip is needed.
 * Typed structurally to the shape `getPreimageManager()` returns in
 * `@parity/product-sdk-host`, so this package does not depend on it. `null`
 * after `timeoutMs` without an answer.
 */
export function preimageSource(
    manager: {
        lookup(
            key: `0x${string}`,
            callback: (preimage: Uint8Array | null) => void,
        ): { unsubscribe?: () => void; onInterrupt?: (callback: () => void) => () => void };
    },
    timeoutMs = 20_000,
): ArtworkSource {
    return (address, signal) =>
        new Promise((resolve) => {
            // Filled in as the lookup starts, read by `settle` whenever it runs.
            const live: {
                settled: boolean;
                timer?: ReturnType<typeof setTimeout>;
                subscription?: ReturnType<typeof manager.lookup>;
                cancelInterrupt?: () => void;
            } = { settled: false };
            const onAbort = () => settle(null);
            function settle(value: Uint8Array | null): void {
                if (live.settled) return;
                live.settled = true;
                clearTimeout(live.timer);
                signal?.removeEventListener("abort", onAbort);
                live.cancelInterrupt?.();
                live.subscription?.unsubscribe?.();
                resolve(value);
            }
            if (signal?.aborted) return settle(null);
            signal?.addEventListener("abort", onAbort);
            live.timer = setTimeout(() => settle(null), timeoutMs);
            // A null answer means "not found yet", and the host keeps looking.
            live.subscription = manager.lookup(address.digest, (preimage) => {
                if (preimage !== null) settle(preimage);
            });
            live.cancelInterrupt = live.subscription.onInterrupt?.(() => settle(null));
            if (live.settled) live.subscription.unsubscribe?.();
        });
}

/**
 * A source over an IPFS gateway by CID. A non-2xx answer is `null`, since a
 * gateway 404 is the ordinary way of saying it does not have the bytes.
 */
export function gatewaySource(baseUrl: string, fetchImpl: typeof fetch = fetch): ArtworkSource {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return async (address, signal) => {
        const response = await fetchImpl(`${base}${address.cid}`, { signal });
        if (!response.ok) return null;
        return new Uint8Array(await response.arrayBuffer());
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    const bytes = new TextEncoder().encode("a small webp, or so we claim");
    const digest = blake2b256(bytes);
    const CID = cidFor(digest, BLAKE2B_256);
    const HEX = toHex(digest);
    const ref = (image: Partial<ImageRef>): ImageRef => ({ hex: HEX, text: null, ...image });
    const sourceOf = (answer: Uint8Array | null) => {
        const asked: ArtworkAddress[] = [];
        const source: ArtworkSource = async (address) => {
            asked.push(address);
            return answer;
        };
        return { source, asked };
    };

    describe("artworkAddress", () => {
        test("a CID carries its own multihash", () => {
            const address = artworkAddress(ref({ text: CID }));
            expect(address).toEqual({ cid: CID, digest: HEX, multihash: BLAKE2B_256 });
        });

        test("a bare digest is taken as blake2b-256 and given a CID", () => {
            const address = artworkAddress(ref({ text: null }));
            expect(address).toEqual({ cid: CID, digest: HEX, multihash: BLAKE2B_256 });
        });

        test("a sha2-256 CID keeps its code", () => {
            const sha = sha256(bytes);
            const address = artworkAddress(ref({ hex: toHex(sha), text: cidFor(sha, SHA2_256) }));
            expect(address?.multihash).toBe(SHA2_256);
        });

        test("text that is not a CID falls back to the hex", () => {
            const address = artworkAddress(ref({ text: "not a cid" }));
            expect(address?.cid).toBe(CID);
        });

        test("a CID with trailing bytes after the digest is not a CID", () => {
            const padded = `${CID}aa`;
            expect(artworkAddress({ hex: "0x00", text: padded })).toBeNull();
        });

        test("an upper-case multibase CID reads as the same address", () => {
            const upper = `B${CID.slice(1).toUpperCase()}`;
            // A hex that decodes to nothing, so only the CID can supply the digest.
            expect(artworkAddress({ hex: "0x00", text: upper })?.digest).toBe(HEX);
        });

        test("nothing readable is null", () => {
            expect(artworkAddress({ hex: "0x1234", text: null })).toBeNull();
        });
    });

    describe("getVerifiedArtwork", () => {
        test("bytes that hash to the digest are verified", async () => {
            const { source, asked } = sourceOf(bytes);
            const result = await getVerifiedArtwork(ref({ text: CID }), { source });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value.tag).toBe("Verified");
            if (result.value.tag === "Verified") expect(result.value.bytes).toBe(bytes);
            expect(asked[0]?.digest).toBe(HEX);
        });

        test("bytes that do not hash to the digest are a mismatch, and not handed over", async () => {
            const { source } = sourceOf(new TextEncoder().encode("something else"));
            const result = await getVerifiedArtwork(ref({}), { source });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value).toEqual({
                tag: "Mismatch",
                address: { cid: CID, digest: HEX, multihash: BLAKE2B_256 },
            });
        });

        test("a source with nothing is missing", async () => {
            const { source } = sourceOf(null);
            const result = await getVerifiedArtwork(ref({}), { source });
            expect(result.ok && result.value.tag).toBe("Missing");
        });

        test("a sha2-256 address verifies with sha2-256", async () => {
            const sha = sha256(bytes);
            const { source } = sourceOf(bytes);
            const result = await getVerifiedArtwork(
                ref({ hex: toHex(sha), text: cidFor(sha, SHA2_256) }),
                { source },
            );
            expect(result.ok && result.value.tag).toBe("Verified");
        });

        test("no image, or one that cannot be decoded, is unreadable without asking the source", async () => {
            const { source, asked } = sourceOf(bytes);
            expect((await getVerifiedArtwork(null, { source })).ok).toBe(true);
            const result = await getVerifiedArtwork({ hex: "0xzz", text: null }, { source });
            expect(result.ok && result.value.tag).toBe("Unreadable");
            expect(asked).toEqual([]);
        });

        test("a source that throws lands on the err channel", async () => {
            const source: ArtworkSource = async () => {
                throw new Error("gateway down");
            };
            const result = await getVerifiedArtwork(ref({}), { source });
            expect(result.ok).toBe(false);
        });

        test("an aborted signal lands on the err channel before the source is asked", async () => {
            const { source, asked } = sourceOf(bytes);
            const controller = new AbortController();
            controller.abort();
            const result = await getVerifiedArtwork(ref({}), { source, signal: controller.signal });
            expect(result.ok).toBe(false);
            expect(asked).toEqual([]);
        });
    });

    describe("preimageSource", () => {
        test("looks the digest up and unsubscribes on the first answer", async () => {
            let unsubscribed = 0;
            const manager = {
                lookup: (key: string, callback: (preimage: Uint8Array | null) => void) => {
                    expect(key).toBe(HEX);
                    queueMicrotask(() => callback(bytes));
                    return {
                        unsubscribe: () => {
                            unsubscribed += 1;
                        },
                    };
                },
            };
            const address = artworkAddress(ref({})) as ArtworkAddress;
            expect(await preimageSource(manager)(address)).toBe(bytes);
            expect(unsubscribed).toBe(1);
        });

        test("a null answer is 'not found yet', so it waits for the bytes", async () => {
            const manager = {
                lookup: (_key: string, callback: (preimage: Uint8Array | null) => void) => {
                    queueMicrotask(() => callback(null));
                    setTimeout(() => callback(bytes), 5);
                    return { unsubscribe: () => {} };
                },
            };
            const address = artworkAddress(ref({})) as ArtworkAddress;
            expect(await preimageSource(manager, 1000)(address)).toBe(bytes);
        });

        test("an interrupted lookup settles as null and unsubscribes", async () => {
            let interrupt: () => void = () => {};
            let unsubscribed = 0;
            const manager = {
                lookup: () => ({
                    unsubscribe: () => {
                        unsubscribed += 1;
                    },
                    onInterrupt: (callback: () => void) => {
                        interrupt = callback;
                        return () => {};
                    },
                }),
            };
            const address = artworkAddress(ref({})) as ArtworkAddress;
            const pending = preimageSource(manager, 60_000)(address);
            interrupt();
            // Settled by the interrupt, not by the minute-long timeout.
            const raced = await Promise.race([
                pending,
                new Promise((resolve) => setTimeout(() => resolve("still pending"), 50)),
            ]);
            expect(raced).toBeNull();
            expect(unsubscribed).toBe(1);
        });

        test("null when the host never answers", async () => {
            const manager = { lookup: () => ({ unsubscribe: () => {} }) };
            const address = artworkAddress(ref({})) as ArtworkAddress;
            expect(await preimageSource(manager, 5)(address)).toBeNull();
        });
    });

    describe("gatewaySource", () => {
        test("fetches by CID and treats a miss as null", async () => {
            const urls: string[] = [];
            const fetchImpl = (async (url: string) => {
                urls.push(url);
                return url.endsWith(CID)
                    ? new Response(bytes, { status: 200 })
                    : new Response(null, { status: 404 });
            }) as unknown as typeof fetch;
            const address = artworkAddress(ref({})) as ArtworkAddress;
            const source = gatewaySource("https://gateway.example/ipfs", fetchImpl);
            expect(await source(address)).toEqual(bytes);
            expect(urls).toEqual([`https://gateway.example/ipfs/${CID}`]);
            const missing = gatewaySource("https://gateway.example/ipfs/", fetchImpl);
            expect(await missing({ ...address, cid: "bmissing" })).toBeNull();
        });
    });
}
