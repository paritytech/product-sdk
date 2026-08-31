// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Where the personhood rings live, and which context the chain scores in.
 *
 * Ring-VRF host calls (`registerRingVrfKey`, `listRingVrfKeys`,
 * `createAccountProof`) address a ring by a {@link RingLocation}. On the
 * individuality chain there are exactly two: the *people* ring (full persons,
 * member-key index 0) and the *people-lite* ring (lite persons, index 1),
 * differing only in their `CollectionId` junction. {@link peopleRing} and
 * {@link litePeopleRing} build them from a genesis hash; nothing here talks to
 * a host.
 *
 * {@link readScoreContext} is the one read: the 32-byte context every lite
 * proof must be minted in is the runtime constant `Score.score_context`, and on
 * a runtime that derives its contexts the product way it equals
 * `productContext("peopl." ++ Score.Suffix, Index(0))` — a context any stock
 * host can mint. A runtime where the two disagree (nextv2's pre-#1300 `pop:`
 * literals) publishes a context no host will sign in, so the read reports that
 * as {@link ScoreContext} `NotProductDerived` and callers must not build a
 * proof leg — the chain would reject it as `InvalidTransaction::Call` with
 * nothing local to read.
 */
import { err, normalizeError, ok, type Result } from "@parity/result";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@parity/product-sdk-utils";
import { PERSONHOOD_CONTEXT_INDEX, PERSONHOOD_PRODUCT_NAME, productContext } from "./contexts.js";
import { IndividualityDecodeError, ProductIndividualityError } from "./errors.js";

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
 * The *people* ring (full persons, member-key index 0) on the chain with
 * genesis `genesisHash`. The host resolves the `Members` pallet by name, so no
 * `PalletInstance` junction is needed.
 */
export function peopleRing(genesisHash: Hex): RingLocation {
    return personhoodRing(genesisHash, "people");
}

/**
 * The *people-lite* ring (lite persons, member-key index 1) on the chain with
 * genesis `genesisHash`.
 */
export function litePeopleRing(genesisHash: Hex): RingLocation {
    return personhoodRing(genesisHash, "people-lite");
}

/**
 * The two constants {@link readScoreContext} reads. Constants are served from
 * the client's runtime rather than a block, so this does not extend
 * `PinnedChain`.
 *
 * Matched by hand against the previewnet descriptors on 2026-08-31:
 *
 * ```
 * Score.score_context: PlainDescriptor<SizedHex<32>>
 * Score.Suffix:        PlainDescriptor<Uint8Array>
 * ```
 */
export interface ScoreContextChain {
    individuality: {
        constants: {
            Score: {
                /** The 32-byte context scores are proven in, as `0x` hex. */
                score_context(): Promise<string>;
                /** The network's DotNS TLD, as UTF-8 bytes (`"test"`, `"paseo"`). */
                Suffix(): Promise<Uint8Array>;
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
 */
export type ScoreContext =
    | {
          tag: "ProductDerived";
          /** The 32-byte constant, equal to `productContext(productId, Index(0))`. */
          context: Uint8Array;
          /** `peopl.<Score.Suffix>` — the product id hosts mint this context under. */
          productId: string;
          /** The network's DotNS TLD, decoded from `Score.Suffix`. */
          tld: string;
      }
    | {
          tag: "NotProductDerived";
          /** The 32-byte constant the chain actually published. */
          context: Uint8Array;
          /** The product id whose `Index(0)` context it was expected to be. */
          productId: string;
      };

/** Options for {@link readScoreContext}. */
export interface ReadScoreContextOptions {
    signal?: AbortSignal;
}

const CONTEXT_HEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Read `Score.score_context` and the product id it should derive from, and
 * check the two agree.
 *
 * ```ts
 * const score = await readScoreContext(chain);
 * if (score.ok && score.value.tag === "ProductDerived") {
 *     // mint proofs in { productId: score.value.productId, suffix: Index(0) }
 * }
 * ```
 */
export async function readScoreContext(
    chain: ScoreContextChain,
    options: ReadScoreContextOptions = {},
): Promise<Result<ScoreContext, ProductIndividualityError>> {
    try {
        options.signal?.throwIfAborted();
        const constants = chain.individuality.constants.Score;
        const [constant, suffix] = await Promise.all([
            constants.score_context(),
            constants.Suffix(),
        ]);
        if (!CONTEXT_HEX.test(constant)) {
            throw new IndividualityDecodeError("score context constant is not 32 bytes of hex");
        }
        const context = hexToBytes(constant.slice(2));
        const tld = new TextDecoder().decode(suffix);
        const productId = `${PERSONHOOD_PRODUCT_NAME}.${tld}`;
        const derived = productContext(productId, {
            tag: "Index",
            value: PERSONHOOD_CONTEXT_INDEX.score,
        });
        if (bytesToHex(derived) === bytesToHex(context)) {
            return ok({ tag: "ProductDerived", context, productId, tld });
        }
        return ok({ tag: "NotProductDerived", context, productId });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    const hex = (bytes: Uint8Array): string =>
        `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

    /** Previewnet's published `Score.score_context` (spec 1000036). */
    const PREVIEWNET_SCORE_CONTEXT =
        "0xa02ef8d90148203d1b7573e28c044c7b46e42793766bf6d7687ef5da86024a8e";

    function fakeChain(scoreContext: string | Promise<string>, suffix = "test"): ScoreContextChain {
        return {
            individuality: {
                constants: {
                    Score: {
                        score_context: () => Promise.resolve(scoreContext),
                        Suffix: () => Promise.resolve(utf8ToBytes(suffix)),
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
        test("answers ProductDerived for previewnet's published constant", async () => {
            const result = await readScoreContext(fakeChain(PREVIEWNET_SCORE_CONTEXT));
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
            const result = await readScoreContext(fakeChain(shouting));
            expect(result.ok && result.value.tag).toBe("ProductDerived");
        });

        test("answers NotProductDerived for a literal context, on the ok channel", async () => {
            // The nextv2 shape: a pre-#1300 ASCII literal, valid hex but not the
            // product derivation of peopl.<Suffix>/Index(0).
            const literal = hex(utf8ToBytes("pop:polkadot.network/score      "));
            const result = await readScoreContext(fakeChain(literal, "paseo"));
            expect(result).toEqual(
                ok({
                    tag: "NotProductDerived",
                    context: hexToBytes(literal.slice(2)),
                    productId: "peopl.paseo",
                }),
            );
        });

        test("a malformed constant is a decode error on the err channel", async () => {
            const result = await readScoreContext(fakeChain("0xa02e"));
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(IndividualityDecodeError);
            }
        });

        test("a failing read arrives as the package error", async () => {
            const result = await readScoreContext(
                fakeChain(Promise.reject(new Error("node unreachable"))),
            );
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBeInstanceOf(ProductIndividualityError);
            }
        });

        test("an aborted signal throws before any round trip", async () => {
            let fetched = false;
            const chain: ScoreContextChain = {
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
}
