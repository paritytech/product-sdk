// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Where the personhood rings live, and which context the chain scores in.
 *
 * Ring-VRF host calls (`registerRingVrfKey`, `listRingVrfKeys`,
 * `createAccountProof`) address a ring by a {@link RingLocation}. On the
 * individuality chain there are exactly two, the *people* ring for full persons
 * and the *people-lite* ring for lite persons, differing only in their
 * `CollectionId` junction. {@link peopleRing} and
 * {@link litePeopleRing} build them from a genesis hash; nothing here talks to
 * a host.
 *
 * {@link readScoreContext} is the one read: the 32-byte context every lite
 * proof must be minted in is the runtime constant `Score.score_context`, and on
 * a runtime that derives its contexts the product way it equals
 * `personhoodContext(<network suffix>, "score")` — a context any stock host can
 * mint.
 *
 * Where a runtime keeps that suffix is typed rather than probed: {@link
 * NetworkSuffixChain}, {@link LegacySuffixChain}, or neither, and the caller says.
 *
 * A runtime whose published context is not that derivation (nextv2's pre-#1300
 * `pop:` literals) publishes a context no host will sign in, so the read reports
 * that as {@link ScoreContext} `NotProductDerived` and callers must not build a
 * proof leg — the chain would reject it as `InvalidTransaction::Call` with
 * nothing local to read.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@parity/product-sdk-utils";
import { PERSONHOOD_PRODUCT_NAME, personhoodContext } from "./contexts.js";
import { IndividualityDecodeError, ProductIndividualityError } from "./errors.js";
import { pinBlock, readAt, type PinnedChain, type ReadAt } from "./pinned.js";
import type { FinalizedSnapshot } from "./types.js";

/** `0x`-prefixed hex, as truapi's wire types spell it. */
type Hex = `0x${string}`;

/**
 * Where a ring lives: a chain, and a junction path addressing the ring on it.
 *
 * Structurally compatible with the host's `RingLocation`, and declared here
 * rather than imported so this package needs no dependency on
 * `@parity/product-sdk-host`. Same approach as `RingVRFProof`.
 */
export interface RingLocation {
    /** Genesis hash of the chain hosting the ring. */
    chainId: Hex;
    /** Path addressing the ring within the chain. */
    junctions: Array<
        { tag: "PalletInstance"; value: number } | { tag: "CollectionId"; value: Hex }
    >;
}

/** `Members` keys collections by a 32-byte id. */
const COLLECTION_ID_BYTES = 32;

/**
 * A personhood ring's collection identifier: the human-readable name,
 * space-padded to the 32-byte `CollectionId` the `Members` pallet keys on.
 * Lite and full personhood differ *only* in this junction.
 */
export function ringCollectionId(name: "people" | "people-lite"): Uint8Array {
    const id = new Uint8Array(COLLECTION_ID_BYTES).fill(0x20);
    id.set(utf8ToBytes(`pop:polkadot.network/${name}`));
    return id;
}

function personhoodRing(genesisHash: Hex, name: "people" | "people-lite"): RingLocation {
    return {
        chainId: genesisHash,
        junctions: [
            { tag: "CollectionId", value: `0x${bytesToHex(ringCollectionId(name))}` as Hex },
        ],
    };
}

/**
 * The *people* ring on the chain with genesis `genesisHash`. The host resolves
 * the `Members` pallet by name, so no `PalletInstance` junction is needed.
 */
export function peopleRing(genesisHash: Hex): RingLocation {
    return personhoodRing(genesisHash, "people");
}

/**
 * The *people-lite* ring on the chain with genesis `genesisHash`.
 */
export function litePeopleRing(genesisHash: Hex): RingLocation {
    return personhoodRing(genesisHash, "people-lite");
}

/**
 * The published context every score proof must be minted in.
 *
 * Separate from the suffix contracts because merging them needs optional
 * members, which constrain nothing structurally and blind the umbrella guard.
 *
 * Matched by hand against the previewnet descriptors on 2026-08-31:
 *
 * ```
 * Score.score_context: PlainDescriptor<SizedHex<32>>
 * ```
 */
export interface ScoreContextChain {
    individuality: {
        constants: {
            Score: {
                /** The 32-byte context scores are proven in, as `0x` hex. */
                score_context(): Promise<string>;
            };
        };
    };
}

/**
 * The network suffix since individuality-community #20. Root can move it between
 * blocks, so it is read at a pinned one. The pallet is testnet-only upstream, so
 * production has neither this nor {@link LegacySuffixChain} and the caller says.
 *
 * ```
 * NetworkSuffix.NetworkSuffix: StorageDescriptor<[], Uint8Array, false, never>
 * ```
 */
export interface NetworkSuffixChain extends PinnedChain {
    individuality: {
        query: {
            NetworkSuffix: {
                NetworkSuffix: {
                    getValue(options: ReadAt): Promise<Uint8Array>;
                };
            };
        };
    };
}

/**
 * The network suffix before #20. Previewnet only, and gone on its next upgrade.
 *
 * ```
 * Score.Suffix: PlainDescriptor<Uint8Array>
 * ```
 */
export interface LegacySuffixChain {
    individuality: {
        constants: {
            Score: {
                /** The network's DotNS TLD, as UTF-8 bytes (`"test"`, `"paseo"`). */
                Suffix(): Promise<Uint8Array>;
            };
        };
    };
}

/** Private: the overloads are what make the suffix source a checked fact. */
interface AnyScoreContextChain extends ScoreContextChain {
    raw?: PinnedChain["raw"];
    individuality: {
        constants: {
            Score: {
                score_context(): Promise<string>;
                Suffix?(): Promise<Uint8Array>;
            };
        };
        query?: {
            NetworkSuffix?: {
                NetworkSuffix: { getValue(options: ReadAt): Promise<Uint8Array> };
            };
        };
    };
}

/**
 * The chain's score context, and whether a host can mint proofs in it.
 *
 * `NotProductDerived` is an answer, not a failure — it is the state nextv2 is
 * in — so it travels on the `ok` channel, like `UsernameUnowned` does. Every
 * proof-building flow must treat it as a hard stop.
 *
 * A chain that will not say what its suffix is has no variant here; it is
 * rejected at compile time.
 */
export type ScoreContext = {
    tag: "ProductDerived" | "NotProductDerived";
    context: Uint8Array;
    /** `peopl.<tld>`, the id hosts mint this context under. */
    productId: string;
    tld: string;
    /** Absent unless the suffix came from storage; nothing else pins. */
    at?: FinalizedSnapshot;
};

/** Options for {@link readScoreContext}. */
export interface ReadScoreContextOptions {
    signal?: AbortSignal;
    /** Required when the chain publishes no suffix, and wins when it does. */
    tld?: string;
}

const CONTEXT_HEX = /^0x[0-9a-fA-F]{64}$/;

/** Fatal, so bad bytes fail the read rather than becoming U+FFFD in a product id. */
const SUFFIX_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Read `Score.score_context` and check it is the product derivation of
 * `peopl.<tld>/Index(0)` — the only kind of context a stock host can mint.
 *
 * A chain's suffix source is fixed by its type, so one with none is a compile
 * error rather than a runtime disappointment.
 *
 * ```ts
 * const score = await readScoreContext(chain, { tld: "paseo" });
 * if (score.ok && score.value.tag === "ProductDerived") {
 *     // mint proofs in { productId: score.value.productId, suffix: Index(0) }
 * }
 * ```
 */
export async function readScoreContext(
    chain: ScoreContextChain & NetworkSuffixChain,
    options?: ReadScoreContextOptions,
): Promise<Result<ScoreContext, ProductIndividualityError>>;
export async function readScoreContext(
    chain: ScoreContextChain & LegacySuffixChain,
    options?: ReadScoreContextOptions,
): Promise<Result<ScoreContext, ProductIndividualityError>>;
export async function readScoreContext(
    chain: ScoreContextChain,
    options: ReadScoreContextOptions & { tld: string },
): Promise<Result<ScoreContext, ProductIndividualityError>>;
export async function readScoreContext(
    chain: AnyScoreContextChain,
    options: ReadScoreContextOptions = {},
): Promise<Result<ScoreContext, ProductIndividualityError>> {
    try {
        return ok(await runScoreContextRead(chain, options));
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

/**
 * Throws; {@link readScoreContext} owns the `Result` boundary. Exported so a
 * composing read can run it against a block it already pinned, like
 * `prize-status.ts` runs `runDrawRead`, rather than pinning a second.
 */
export async function runScoreContextRead(
    chain: AnyScoreContextChain,
    options: ReadScoreContextOptions = {},
    pinned?: FinalizedSnapshot,
): Promise<ScoreContext> {
    options.signal?.throwIfAborted();
    const [constant, resolved] = await Promise.all([
        chain.individuality.constants.Score.score_context(),
        resolveSuffix(chain, options, pinned),
    ]);
    if (!CONTEXT_HEX.test(constant)) {
        throw new IndividualityDecodeError("score context constant is not 32 bytes of hex");
    }
    const context = hexToBytes(constant.slice(2));
    const { tld, at } = resolved;
    const derived = personhoodContext(tld, "score");
    const productId = `${PERSONHOOD_PRODUCT_NAME}.${tld}`;
    const tag = derived.every((byte, index) => byte === context[index])
        ? "ProductDerived"
        : "NotProductDerived";
    return at === undefined
        ? { tag, context, productId, tld }
        : { tag, context, productId, tld, at };
}

/** Storage beats the constant: Root can move it under a chain whose constant is stale. */
async function resolveSuffix(
    chain: AnyScoreContextChain,
    options: ReadScoreContextOptions,
    pinned: FinalizedSnapshot | undefined,
): Promise<{ tld: string; at?: FinalizedSnapshot }> {
    if (options.tld !== undefined) {
        return { tld: options.tld };
    }
    const stored = chain.individuality.query?.NetworkSuffix?.NetworkSuffix;
    if (stored !== undefined) {
        // runScoreContextRead is looser than the overloads, so `raw` can be missing.
        if (chain.raw === undefined && pinned === undefined) {
            throw new ProductIndividualityError(
                "reading the suffix from storage needs a finalized block",
            );
        }
        const snapshot = await pinBlock(chain as PinnedChain, options.signal, pinned);
        return {
            tld: SUFFIX_DECODER.decode(await stored.getValue(readAt(snapshot, options.signal))),
            at: snapshot,
        };
    }
    const constant = chain.individuality.constants.Score.Suffix;
    if (constant !== undefined) {
        return { tld: SUFFIX_DECODER.decode(await constant()) };
    }
    // Unreachable through the overloads; runScoreContextRead is not as strict.
    throw new ProductIndividualityError("chain publishes no network suffix and none was supplied");
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const hex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

    /** Previewnet's published `Score.score_context` (spec 1000036). */
    const PREVIEWNET_SCORE_CONTEXT =
        "0xa02ef8d90148203d1b7573e28c044c7b46e42793766bf6d7687ef5da86024a8e";

    /** A pre-#1300 ASCII literal: valid hex, not a product derivation. */
    const LITERAL = hex(utf8ToBytes("pop:polkadot.network/score      "));

    const BLOCK = { hash: `0x${"77".repeat(32)}`, number: 42 };
    const SNAPSHOT = { blockHash: BLOCK.hash, blockNumber: BLOCK.number };

    /** Production, and paseo today. */
    function bareChain(scoreContext: string | Promise<string>): ScoreContextChain {
        return {
            individuality: {
                constants: { Score: { score_context: () => Promise.resolve(scoreContext) } },
            },
        };
    }

    /** Previewnet today. */
    function legacyChain(
        scoreContext: string | Promise<string>,
        suffix: Uint8Array = utf8ToBytes("test"),
    ): ScoreContextChain & LegacySuffixChain {
        return {
            individuality: {
                constants: {
                    Score: {
                        score_context: () => Promise.resolve(scoreContext),
                        Suffix: () => Promise.resolve(suffix),
                    },
                },
            },
        };
    }

    /** Post-#20, and nothing yet. */
    function storageChain(
        scoreContext: string | Promise<string>,
        suffix = "test",
        onPin?: () => void,
    ): ScoreContextChain & NetworkSuffixChain {
        return {
            raw: {
                individuality: {
                    getFinalizedBlock: () => {
                        onPin?.();
                        return Promise.resolve(BLOCK);
                    },
                },
            },
            individuality: {
                constants: { Score: { score_context: () => Promise.resolve(scoreContext) } },
                query: {
                    NetworkSuffix: {
                        NetworkSuffix: { getValue: () => Promise.resolve(utf8ToBytes(suffix)) },
                    },
                },
            },
        };
    }

    describe("ringCollectionId", () => {
        test("pins both 32-byte, space-padded collection ids", () => {
            expect(hex(ringCollectionId("people"))).toBe(
                "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020",
            );
            expect(hex(ringCollectionId("people-lite"))).toBe(
                "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652d6c697465",
            );
        });
    });

    describe("peopleRing / litePeopleRing", () => {
        test("address the collection on the given chain with no pallet junction", () => {
            const genesis = `0x${"ab".repeat(32)}` as const;
            expect(peopleRing(genesis)).toEqual({
                chainId: genesis,
                junctions: [
                    {
                        tag: "CollectionId",
                        value: "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020",
                    },
                ],
            });
            expect(litePeopleRing(genesis)).toEqual({
                chainId: genesis,
                junctions: [
                    {
                        tag: "CollectionId",
                        value: "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652d6c697465",
                    },
                ],
            });
        });
    });

    describe("readScoreContext", () => {
        test("answers ProductDerived from the legacy constant", async () => {
            const result = await readScoreContext(legacyChain(PREVIEWNET_SCORE_CONTEXT));
            expect(result).toEqual(
                ok({
                    tag: "ProductDerived",
                    context: hexToBytes(PREVIEWNET_SCORE_CONTEXT.slice(2)),
                    productId: "peopl.test",
                    tld: "test",
                }),
            );
        });

        test("accepts upper-case constant hex", async () => {
            const shouting = `0x${PREVIEWNET_SCORE_CONTEXT.slice(2).toUpperCase()}`;
            const result = await readScoreContext(legacyChain(shouting));
            expect(result.ok && result.value.tag).toBe("ProductDerived");
        });

        test("resolves the suffix from storage, and reports the block it read at", async () => {
            const result = await readScoreContext(storageChain(PREVIEWNET_SCORE_CONTEXT));
            expect(result).toEqual(
                ok({
                    tag: "ProductDerived",
                    context: hexToBytes(PREVIEWNET_SCORE_CONTEXT.slice(2)),
                    productId: "peopl.test",
                    tld: "test",
                    at: SNAPSHOT,
                }),
            );
        });

        test("an explicit tld overrides the chain and skips the lookup", async () => {
            let pinned = false;
            const chain = storageChain(PREVIEWNET_SCORE_CONTEXT, "test", () => {
                pinned = true;
            });
            const result = await readScoreContext(chain, { tld: "paseo" });
            expect(result.ok && result.value.tld).toBe("paseo");
            expect(result.ok && result.value.tag).toBe("NotProductDerived");
            expect(pinned).toBe(false);
        });

        test("answers NotProductDerived for a literal context, on the ok channel", async () => {
            // A literal-publishing runtime has no suffix, so a caller-supplied
            // tld is the only way this variant is reachable at all.
            const result = await readScoreContext(bareChain(LITERAL), { tld: "paseo" });
            expect(result).toEqual(
                ok({
                    tag: "NotProductDerived",
                    context: hexToBytes(LITERAL.slice(2)),
                    productId: "peopl.paseo",
                    tld: "paseo",
                }),
            );
        });

        test("a suffix that is not UTF-8 is an error, not a mangled product id", async () => {
            const chain = legacyChain(PREVIEWNET_SCORE_CONTEXT, new Uint8Array([0xff, 0xfe]));
            const result = await readScoreContext(chain);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(ProductIndividualityError);
            }
        });

        test("a malformed constant is a decode error on the err channel", async () => {
            const result = await readScoreContext(legacyChain("0xa02e"));
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(IndividualityDecodeError);
            }
        });

        test("a failing read arrives as the package error", async () => {
            const result = await readScoreContext(
                legacyChain(Promise.reject(new Error("node unreachable"))),
            );
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(ProductIndividualityError);
            }
        });

        test("an aborted signal throws before any round trip", async () => {
            let fetched = false;
            const chain: ScoreContextChain & LegacySuffixChain = {
                individuality: {
                    constants: {
                        Score: {
                            score_context: () => {
                                fetched = true;
                                return Promise.resolve(PREVIEWNET_SCORE_CONTEXT);
                            },
                            Suffix: () => {
                                fetched = true;
                                return Promise.resolve(utf8ToBytes("test"));
                            },
                        },
                    },
                },
            };
            const controller = new AbortController();
            controller.abort();
            const result = await readScoreContext(chain, { signal: controller.signal });
            expect(result.ok).toBe(false);
            expect(fetched).toBe(false);
        });
    });

    describe("runScoreContextRead", () => {
        test("reads at a snapshot it was handed, pinning no second block", async () => {
            let pinned = false;
            const chain = storageChain(PREVIEWNET_SCORE_CONTEXT, "test", () => {
                pinned = true;
            });
            const composed = { blockHash: `0x${"99".repeat(32)}`, blockNumber: 7 };
            const score = await runScoreContextRead(chain, {}, composed);
            expect(pinned).toBe(false);
            expect(score.at).toEqual(composed);
        });

        test("throws the package error when storage has no block source", async () => {
            const chain = storageChain(PREVIEWNET_SCORE_CONTEXT);
            const { raw: _raw, ...blockless } = chain;
            await expect(runScoreContextRead(blockless as typeof chain)).rejects.toBeInstanceOf(
                ProductIndividualityError,
            );
        });

        test("a handed-in snapshot needs no block source", async () => {
            const chain = storageChain(PREVIEWNET_SCORE_CONTEXT);
            const { raw: _raw, ...blockless } = chain;
            const composed = { blockHash: `0x${"99".repeat(32)}`, blockNumber: 7 };
            const score = await runScoreContextRead(blockless as typeof chain, {}, composed);
            expect(score.tag).toBe("ProductDerived");
        });

        test("throws when nothing can resolve the suffix", async () => {
            await expect(runScoreContextRead(bareChain(LITERAL))).rejects.toBeInstanceOf(
                ProductIndividualityError,
            );
        });
    });
}
