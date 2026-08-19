// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time guard for the chain contract in `@parity/product-sdk-individuality`.
 *
 * That package types its chain parameter structurally, listing the storage
 * entries it needs rather than naming a descriptor. That keeps it free of a
 * chain-client dependency and lets its tests use a plain double, at the cost that
 * the contract can drift from the real chain silently, since the double satisfies
 * it by construction.
 *
 * This file closes that gap: if a descriptor regeneration changes a key or a
 * value type, `pnpm typecheck` fails here. It guards both of that package's
 * chain contracts, `IndividualityChain` for the personhood batch and
 * `ConsumersChain` for the account to username read.
 *
 * **It checks the built `dist`, not the sibling's `src`.** The contracts resolve
 * through `@parity/product-sdk-individuality`'s `types` field, so editing a
 * contract and running this typecheck without rebuilding that package asserts
 * against the previous build. Run `pnpm -r build` first, or the guard silently
 * checks stale types. Verified 2026-08-19 by mutating a contract and watching
 * the typecheck pass until the sibling was rebuilt.
 *
 * **It lives in the umbrella package deliberately.** Inside the individuality
 * package the same assertion is vacuous, passing even against a contract that
 * demands a pallet the chain does not have, because the descriptor types do not
 * fully resolve through that package's dependency graph. Here, where both
 * `chain-client` and the individuality package are direct dependencies, it
 * correctly rejects a bogus contract. The negative control below keeps that
 * property honest: if `IndividualityChain` ever stopped constraining, the
 * `@ts-expect-error` would report as unused and this file would fail.
 */
import type { getChainAPI } from "@parity/product-sdk-chain-client";
import type { ConsumersChain, IndividualityChain } from "@parity/product-sdk-individuality";
import { expect, test } from "vitest";

// The false branch must be `false`, not `never`. `never` is assignable to
// `true`, so a `never` branch would make the assertion unfalsifiable.
type Assert<T extends true> = T;

type PaseoClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
type DevnetClient = Awaited<ReturnType<typeof getChainAPI<"devnet">>>;

// These four aliases are the test. Each fails to typecheck if its condition
// breaks, so they need no export and no runtime reference.
type PaseoSatisfiesContract = Assert<PaseoClient extends IndividualityChain ? true : false>;
type DevnetSatisfiesContract = Assert<DevnetClient extends IndividualityChain ? true : false>;

// The account to username direction reads one entry, `Resources.Consumers`, and
// types it in its own narrow contract so a double for either read does not have
// to implement the other's entries. It needs the same guard, and for a sharper
// reason: the value shape was derived from the pallet source and the codegen
// rather than read off the emitted descriptor, so these two lines are what turn
// that derivation into a checked fact.
type PaseoSatisfiesConsumers = Assert<PaseoClient extends ConsumersChain ? true : false>;
type DevnetSatisfiesConsumers = Assert<DevnetClient extends ConsumersChain ? true : false>;

// Negative control, kept type-only so it emits no runtime code. If
// `IndividualityChain` ever stopped constraining, this flips to `false` and the
// file fails to typecheck, which is what keeps the assertions above honest.
type ClientWithoutIndividuality = {
    assetHub: unknown;
    raw: { assetHub: unknown };
    destroy(): void;
};
type RejectsBogusClient = Assert<
    ClientWithoutIndividuality extends IndividualityChain ? false : true
>;
type RejectsBogusConsumersClient = Assert<
    ClientWithoutIndividuality extends ConsumersChain ? false : true
>;

test("the individuality chain contract is asserted at compile time", () => {
    // The type assertions above are the test. This keeps vitest from reporting
    // the file as an empty suite.
    expect(true).toBe(true);
});
