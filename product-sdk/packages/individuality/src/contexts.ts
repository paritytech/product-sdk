// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Product-scoped ring-VRF proof contexts (RFC-0004 / RFC-0022 / RFC-0024).
 *
 * A host never lets a product choose its proof context: it derives it from the
 * product's identity, so a product can prove personhood only in its own
 * namespace. Since individuality `0fec7071` ("Use product-owned personhood
 * contexts") the chain derives its own contexts the same way — every context a
 * runtime accepts is
 *
 * ```
 * context = blake2b-256("product/" ++ product_id ++ "/" ++ suffix_bytes)
 * ```
 *
 * where `suffix_bytes` expands the RFC-0024 `Index`/`Raw` selector:
 *
 * ```
 * Index(n)   -> n as u32 LE ++ blake2b-256("product-account-index")[..28]
 * Raw(bytes) -> the 32 bytes verbatim
 * ```
 *
 * Everything here is pure computation, so a product can *predict* the context a
 * host will use, compare it against what `createAccountProof` actually returns,
 * and hand the constant to off-chain verifiers. The `product_id` is always a
 * full DotNS id (`"peopl.test"`, `"dim2.dot"`): the TLD belongs to the network,
 * and the same name on two networks is two different 32-byte contexts.
 *
 * The personhood product's own contexts are enumerated too, because two of the
 * five never reach metadata (`resources` and `dotnsGateway` are plain `impl`
 * fns, not `#[pallet::extra_constants]`) and so can only be derived
 * client-side. `readScoreContext` in `rings.ts` is the read that checks this
 * derivation against a published constant before anything trusts it.
 */
import { blake2b256, concatBytes, utf8ToBytes } from "@parity/product-sdk-utils";
import { ProductIndividualityError } from "./errors.js";

/**
 * The RFC-0024 context-suffix selector: a plain index, or 32 raw bytes.
 *
 * Structurally the shape of truapi's `DerivationIndex` except that `Raw`
 * carries bytes rather than `0x` hex, because everything in this module is
 * byte-level. Wrap with your transport's hex conversion at the wire boundary.
 */
export type ContextSuffix = { tag: "Index"; value: number } | { tag: "Raw"; value: Uint8Array };

/** Every expanded suffix, and every derived context, is 32 bytes. */
const SUFFIX_BYTES = 32;

/**
 * `blake2b-256("product-account-index")[..28]`, the trailing marker of an
 * expanded `Index` suffix per RFC-0022. A domain-separation constant, not
 * entropy: it keeps a plain index from colliding with a `Raw` payload that
 * happens to start with the same four bytes. Computed rather than pasted so the
 * definition, not a magic array, is what this module asserts.
 */
const INDEX_MAGIC = blake2b256(utf8ToBytes("product-account-index")).subarray(0, SUFFIX_BYTES - 4);

const U32_MAX = 0xff_ff_ff_ff;

/**
 * Expand a {@link ContextSuffix} to the 32 bytes the context hash consumes,
 * mirroring `ProductContextSuffix::bytes()` in `individuality/support`.
 *
 * @throws ProductIndividualityError on an index outside `u32`, or `Raw` bytes
 *   that are not exactly 32.
 */
export function contextSuffixBytes(suffix: ContextSuffix): Uint8Array {
    if (suffix.tag === "Raw") {
        if (suffix.value.length !== SUFFIX_BYTES) {
            throw new ProductIndividualityError("raw context suffix must be 32 bytes");
        }
        return suffix.value.slice();
    }
    if (!Number.isInteger(suffix.value) || suffix.value < 0 || suffix.value > U32_MAX) {
        throw new ProductIndividualityError("context suffix index is out of range");
    }
    const bytes = new Uint8Array(SUFFIX_BYTES);
    new DataView(bytes.buffer).setUint32(0, suffix.value, true);
    bytes.set(INDEX_MAGIC, 4);
    return bytes;
}

/**
 * The 32-byte proof context of `{ productId, suffix }`, mirroring
 * `indiv_support::context::build_product_context`.
 *
 * This is the value that must equal `contextualAlias.context` in every
 * `createAccountProof` / `getAccountAlias` response for that product account,
 * and the value of the on-chain context constants (`Score.score_context` and
 * friends) on a runtime that derives them the product way.
 *
 * @param productId - the full DotNS id, TLD included (`"dim2.dot"`,
 *   `"peopl.test"`). Never assemble it from a hardcoded TLD: the network
 *   decides the TLD, so take it from configuration or from the chain.
 * @throws ProductIndividualityError via {@link contextSuffixBytes}.
 */
export function productContext(productId: string, suffix: ContextSuffix): Uint8Array {
    return blake2b256(
        concatBytes(utf8ToBytes(`product/${productId}/`), contextSuffixBytes(suffix)),
    );
}

/**
 * `personhood::PRODUCT_NAME` — the DotNS name (TLD excluded) the personhood
 * product's contexts derive from, shared by every network.
 */
export const PERSONHOOD_PRODUCT_NAME = "peopl";

/**
 * The context suffix indices the personhood product owns, mirroring
 * `personhood` in `individuality/support/src/context.rs`.
 *
 * Only `score`, `peopleLiteAuth` and `peopleAirdrops` are published as runtime
 * constants; `resources` and `dotnsGateway` exist solely as this derivation, so
 * pinning the published three pins the derivation that produces the other two.
 */
export const PERSONHOOD_CONTEXT_INDEX = {
    score: 0,
    resources: 1,
    peopleLiteAuth: 2,
    dotnsGateway: 3,
    peopleAirdrops: 4,
} as const;

export type PersonhoodContextName = keyof typeof PERSONHOOD_CONTEXT_INDEX;

/** `indiv_support::context::MAX_NETWORK_SUFFIX_LENGTH`. */
const MAX_TLD_BYTES = 16;

/**
 * The personhood product's context for `name` on the network issuing `.<tld>`
 * names: `productContext("peopl.<tld>", Index(PERSONHOOD_CONTEXT_INDEX[name]))`.
 *
 * The TLD belongs to the network (`"test"` on previewnet, `"paseo"` on the
 * paseo networks), so the same context name on two networks is two different
 * values — which is why it is a parameter and never a default.
 *
 * @param tld - a single lower-case DotNS label, without the leading dot.
 * @throws ProductIndividualityError on a tld the runtime cannot represent, or a
 *   composite one: `"peopl" + ".te.st"` and `"peopl.te" + ".st"` would collide.
 */
export function personhoodContext(tld: string, name: PersonhoodContextName): Uint8Array {
    if (
        tld.length === 0 ||
        tld.includes(".") ||
        tld.includes("/") ||
        tld !== tld.toLowerCase() ||
        utf8ToBytes(tld).length > MAX_TLD_BYTES
    ) {
        throw new ProductIndividualityError("personhood context tld must be a single dotns label");
    }
    return productContext(`${PERSONHOOD_PRODUCT_NAME}.${tld}`, {
        tag: "Index",
        value: PERSONHOOD_CONTEXT_INDEX[name],
    });
}

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    /** Hex of bytes, computed here so vectors share no encoder with the code under test. */
    const hex = (bytes: Uint8Array): string =>
        `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

    /** `Index(0)` expanded — the `<idx0>` constant quoted in dim2-spa#97. */
    const IDX0 = "0x0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f";

    describe("contextSuffixBytes", () => {
        test("expands Index(0) to the pinned <idx0> constant", () => {
            expect(hex(contextSuffixBytes({ tag: "Index", value: 0 }))).toBe(IDX0);
        });

        test("encodes the index little-endian in the first four bytes", () => {
            const bytes = contextSuffixBytes({ tag: "Index", value: 0x01_02_03_04 });
            expect(hex(bytes.subarray(0, 4))).toBe("0x04030201");
            // The domain-separation tail is index-independent.
            expect(hex(bytes.subarray(4))).toBe(
                hex(contextSuffixBytes({ tag: "Index", value: 0 }).subarray(4)),
            );
        });

        test("passes Raw bytes through unchanged, as a copy", () => {
            const raw = new Uint8Array(32).fill(7);
            const expanded = contextSuffixBytes({ tag: "Raw", value: raw });
            expect(expanded).toEqual(raw);
            expanded[0] = 0xff;
            expect(raw[0]).toBe(7);
        });

        test.each([31, 33])("rejects %i Raw bytes", (length) => {
            expect(() => contextSuffixBytes({ tag: "Raw", value: new Uint8Array(length) })).toThrow(
                ProductIndividualityError,
            );
        });

        test.each([-1, 1.5, 2 ** 32, Number.NaN])("rejects the index %s", (value) => {
            expect(() => contextSuffixBytes({ tag: "Index", value })).toThrow(
                ProductIndividualityError,
            );
        });
    });

    describe("productContext", () => {
        // Pinned in dim2-spa's proofContext tests against the values in the man
        // chapter /docs/personhood-binding/proofs-from-a-product.
        test.each([
            ["game.dot", "0xca025e3e4a39ed98ed7b0a4d953a1986c172cc8724a56ca504ced5a85cd4b01a"],
            ["dim2.dot", "0x80eb3c1756f471aba0d30cdaca899993588fa4fab2f98c2431c619b6bb418fbb"],
        ])("matches the pinned %s / Index(0) constant", (productId, pinned) => {
            expect(hex(productContext(productId, { tag: "Index", value: 0 }))).toBe(pinned);
        });

        test("gives distinct products distinct contexts", () => {
            const suffix: ContextSuffix = { tag: "Index", value: 0 };
            expect(hex(productContext("dim2.dot", suffix))).not.toBe(
                hex(productContext("dim2.test", suffix)),
            );
        });
    });

    describe("personhoodContext", () => {
        // Read from previewnet's People chain (spec 1000036) as the runtime
        // constants Score.score_context, PeopleLite.auth_context and
        // PeopleAirdrops.people_airdrops_context. Pinning the three that are
        // published pins the derivation that produces the unpublished two.
        test.each([
            ["score", "0xa02ef8d90148203d1b7573e28c044c7b46e42793766bf6d7687ef5da86024a8e"],
            [
                "peopleLiteAuth",
                "0xb2f3d012bd825090725ace97002be3357db3ff42aa4414e4f5bcd751abc8de90",
            ],
            [
                "peopleAirdrops",
                "0xeee07f0e4030bb780f4eb72ecc4f724a522919fb487d58fe9cad4ed69125911f",
            ],
        ] as const)("derives the %s context previewnet publishes", (name, onChain) => {
            expect(hex(personhoodContext("test", name))).toBe(onChain);
        });

        test("derives the Resources context previewnet expects", () => {
            // Not readable from metadata; produced by the derivation the cases
            // above prove, at personhood::RESOURCES (index 1). Pinned in
            // humanity-spa's personhood-context tests.
            expect(hex(personhoodContext("test", "resources"))).toBe(
                "0xa1863952733a5e745cf5691f9a01b0b737ad04c00234784d84064f487973620d",
            );
        });

        test("gives every context name its own value", () => {
            const names = Object.keys(PERSONHOOD_CONTEXT_INDEX) as PersonhoodContextName[];
            const contexts = new Set(names.map((name) => hex(personhoodContext("test", name))));
            expect(contexts.size).toBe(names.length);
        });

        test("gives every network its own value", () => {
            const tlds = ["dot", "test", "paseo"];
            const contexts = new Set(tlds.map((tld) => hex(personhoodContext(tld, "score"))));
            expect(contexts.size).toBe(tlds.length);
        });

        test.each(["", "te.st", "te/st", "TEST", "a".repeat(17)])("rejects the tld %j", (tld) => {
            expect(() => personhoodContext(tld, "score")).toThrow(ProductIndividualityError);
        });

        test("accepts a tld at the 16-byte bound", () => {
            expect(() => personhoodContext("a".repeat(16), "score")).not.toThrow();
        });
    });
}
