// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time guard for the chain contract in `@parity/product-sdk-nfts`.
 *
 * That package types its chain parameter structurally, listing the storage
 * entries it needs rather than naming a descriptor — same trade as
 * `IndividualityChain`, and the same gap: a hand-written contract can drift from
 * the real chain silently, because the package's own test doubles satisfy it by
 * construction. See `../individuality/contract.test.ts` for why this assertion
 * has to live in the umbrella package to mean anything, and why it checks the
 * sibling's built `dist` rather than its `src`.
 *
 * The `ItemDefs` line below is the one that earned this file. PAPI generates its
 * key as `FixedSizeArray<2, number>` rather than the `[number, number]` tuple it
 * gives `CollectionMetadata` and `ItemMetadata`, because the runtime's metadata
 * declares the key type as an array. The raw storage layout is nonetheless two
 * Twox64Concat segments — a genuine two-key map, verified against live state
 * with `rpc.state_getKeys` — so a prefix scan by collection is sound at the
 * protocol level. Whether PAPI's *typing* admits the one-arg `getEntries` that
 * `NftsChain` asks for is a different question, and this is what answers it.
 *
 * **Paseo only, and that asymmetry is the point.** `devnet-asset-hub` carries
 * neither `Scarcity` nor `NftClaims`, so the negative control below is not a
 * hypothetical: it is the live state of the other supported network.
 */
import type { getChainAPI } from "@parity/product-sdk-chain-client";
import type { NftsChain } from "@parity/product-sdk-nfts";
import { expect, test } from "vitest";

// The false branch must be `false`, not `never`. `never` is assignable to
// `true`, so a `never` branch would make the assertion unfalsifiable.
type Assert<T extends true> = T;

type PaseoClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
type DevnetClient = Awaited<ReturnType<typeof getChainAPI<"devnet">>>;

// The test: this alias fails to typecheck if the contract drifts from the
// descriptor, so it needs no export and no runtime reference.
type PaseoSatisfiesContract = Assert<PaseoClient extends NftsChain ? true : false>;

// The negative control, and a real fact about the network rather than a
// hypothetical: devnet Asset Hub has no `Scarcity` and no `NftClaims`. If
// `NftsChain` ever stopped constraining, this `@ts-expect-error` would report
// as unused and the file would fail.
// @ts-expect-error devnet Asset Hub carries neither pallet
type DevnetLacksPallets = Assert<DevnetClient extends NftsChain ? true : false>;

test("nfts chain contract holds against the paseo descriptor", () => {
    // The assertions above are compile-time. This keeps vitest from reporting
    // the file as having no tests, and documents that a green run means tsc
    // accepted them.
    expect(true).toBe(true);
});
