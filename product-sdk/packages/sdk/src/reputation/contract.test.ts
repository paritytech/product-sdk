// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { getChainAPI } from "@parity/product-sdk-chain-client";
import type { HonourChain } from "@parity/product-sdk-reputation";
import { expect, test } from "vitest";
import { createAttestationClient, readHonourTally } from "./index.js";

type Assert<T extends true> = T;
type PaseoClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
type PreviewnetClient = Awaited<ReturnType<typeof getChainAPI<"previewnet">>>;
type PaseoHonour = Assert<PaseoClient extends HonourChain ? true : false>;
type PreviewnetHonour = Assert<PreviewnetClient extends HonourChain ? true : false>;
type RejectMissingPallet = Assert<
    { individuality: { query: Record<string, never> }; raw: PaseoClient["raw"] } extends HonourChain
        ? false
        : true
>;
type TallyValue = Awaited<
    ReturnType<PaseoClient["individuality"]["query"]["Honour"]["Tally"]["getValue"]>
>;
type TallyIsOptionalNumber = Assert<
    [TallyValue] extends [number | undefined]
        ? [number | undefined] extends [TallyValue]
            ? true
            : false
        : false
>;

test("the reputation subpath exports the client and read functions", () => {
    expect(createAttestationClient).toBeTypeOf("function");
    expect(readHonourTally).toBeTypeOf("function");
});
