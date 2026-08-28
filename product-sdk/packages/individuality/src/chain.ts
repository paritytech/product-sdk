// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Adapt a PAPI client the caller already holds to the chain shape every read in
 * this package takes.
 *
 * The reads are typed against the `@parity/product-sdk-chain-client` convention —
 * typed APIs keyed by chain name, raw clients under `raw` — so a product that
 * resolves its own People-chain connection (its own provider, its own descriptors)
 * would otherwise build that object by hand. `fromPapi` builds it, and nothing
 * else: no connection is made and no descriptor is loaded.
 *
 * ```ts
 * import { createClient } from "polkadot-api";
 * import { fromPapi, readCurrentGame } from "@parity/product-sdk-individuality";
 *
 * const client = createClient(provider);
 * const game = await readCurrentGame(fromPapi(client, client.getTypedApi(people)));
 * ```
 *
 * The result is only as complete as `api`: a typed API generated from the
 * individuality chain's metadata satisfies every `*Chain` interface here, and
 * `tsc` checks each entry a read touches against it.
 */

/** The one raw-client method the pinned reads use. Structural, so `PolkadotClient` fits. */
export interface FinalizedBlockSource {
    getFinalizedBlock(): Promise<{ hash: string; number: number }>;
}

/** What {@link fromPapi} returns, with the typed API preserved. */
export interface PapiIndividualityChain<Api> {
    individuality: Api;
    raw: { individuality: FinalizedBlockSource };
}

export function fromPapi<Api>(client: FinalizedBlockSource, api: Api): PapiIndividualityChain<Api> {
    return { individuality: api, raw: { individuality: client } };
}

if (import.meta.vitest) {
    const { expect, test } = import.meta.vitest;

    test("fromPapi places the api and client where the reads look for them", async () => {
        const block = { hash: "0x01", number: 7 };
        const client = { getFinalizedBlock: async () => block };
        const api = { query: {} };
        const chain = fromPapi(client, api);
        expect(chain.individuality).toBe(api);
        await expect(chain.raw.individuality.getFinalizedBlock()).resolves.toEqual(block);
    });
}
