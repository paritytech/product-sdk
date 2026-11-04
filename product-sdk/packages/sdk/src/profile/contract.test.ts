// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time guard for the chain contract in `./types.ts`.
 *
 * `ProfileNftsChain` is `NftsInstancesChain` plus one entry the nfts package
 * does not read, `Scarcity.Instances`, the instance to current owner index.
 * The nfts half is already held against the descriptor by
 * `../nfts/contract.test.ts`; this file holds the added entry the same way,
 * and for the same reason: the package's own test doubles satisfy a
 * hand-written contract by construction, so only a real client can say
 * whether the key is `[bigint]` and the value an SS58 string.
 *
 * It lives here rather than beside the nfts guard because the entry is this
 * module's, and a change to it should fail this module's test.
 *
 * **Paseo only, and that asymmetry is the point.** `devnet-asset-hub` carries
 * no `Scarcity` pallet, so the negative control below is the live state of
 * the other supported network, not a hypothetical.
 */
import type { getChainAPI } from "@parity/product-sdk-chain-client";
import type { deriveEntropy } from "@parity/product-sdk-host";
import { expect, test } from "vitest";

import type { DeriveEntropy } from "./mood.js";
import type { ProfileNftsChain } from "./types.js";

// The false branch must be `false`, not `never`. `never` is assignable to
// `true`, so a `never` branch would make the assertion unfalsifiable.
type Assert<T extends true> = T;

type PaseoClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
type DevnetClient = Awaited<ReturnType<typeof getChainAPI<"devnet">>>;

// The test: this alias fails to typecheck if `Scarcity.Instances` drifts from
// `StorageDescriptor<[Key: bigint], SS58String, true, never>`, or if the nfts
// half the contract extends does. No export and no runtime reference needed.
type PaseoSatisfiesContract = Assert<PaseoClient extends ProfileNftsChain ? true : false>;

// The negative control. If `ProfileNftsChain` ever stopped constraining, this
// `@ts-expect-error` would report as unused and the file would fail.
// @ts-expect-error devnet Asset Hub has no Scarcity pallet
type DevnetLacksScarcity = Assert<DevnetClient extends ProfileNftsChain ? true : false>;

// The host handle `deriveMoodFeed` takes is written by hand so a double can
// satisfy it; this holds it against the host package's real `deriveEntropy`,
// whose error type is narrower than the `Error` the handle accepts.
type HostDerivesEntropy = Assert<typeof deriveEntropy extends DeriveEntropy ? true : false>;

test("profile chain contract holds against the paseo descriptor", () => {
    // The assertions above are compile-time. This keeps vitest from reporting
    // the file as having no tests, and documents that a green run means tsc
    // accepted them.
    expect(true).toBe(true);
});
