// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Known Cloud Storage networks.
 *
 * Each environment pairs its genesis hash with a per-environment PAPI descriptor.
 */
import { paseo_bulletin as paseoBulletinDescriptor } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { summit_bulletin as summitBulletinDescriptor } from "@parity/product-sdk-descriptors/summit-bulletin";
import { devnet_bulletin as devnetBulletinDescriptor } from "@parity/product-sdk-descriptors/devnet-bulletin";

export interface CloudStorageNetwork {
    /** Genesis hash of the underlying chain on this environment. */
    genesisHash: `0x${string}`;
    /** PAPI descriptor for typed API access. */
    descriptor: typeof paseoBulletinDescriptor;
}

/**
 * Cloud Storage network presets.
 *
 * Use these with {@link CloudStorageClient.create} when you want to be explicit
 * about the network rather than passing an environment string. Reads go
 * through the host's preimage subscription (container-only); no gateway
 * URL is configured per network.
 */
export const CloudStorageNetworks = {
    paseo: {
        genesisHash: "0x8cfe6717dc4becfda2e13c488a1e2061ff2dfee96e7d031157f72d36716c0a22",
        descriptor: paseoBulletinDescriptor,
    },
    summit: {
        genesisHash: "0x147aae0d60625af72300d4d5ebd5dcb869f7ac4c6c1a326be1cbb14a4a65ae77",
        // Summit Bulletin shares the Bulletin runtime shape with Paseo; the
        // descriptor type is pinned to the canonical Paseo one so the network
        // interface stays uniform across environments.
        descriptor: summitBulletinDescriptor as typeof paseoBulletinDescriptor,
    },
    devnet: {
        genesisHash: "0xe101f0fa4627d29a257645e02be86d80378fea1a2bf8fa6a918d150ebc760a59",
        // Devnet Bulletin (public Paseo testnet) shares the Bulletin runtime
        // shape with Paseo; the descriptor type is pinned to the canonical
        // Paseo one so the network interface stays uniform across environments.
        descriptor: devnetBulletinDescriptor as typeof paseoBulletinDescriptor,
    },
} as const satisfies Record<string, CloudStorageNetwork>;

/** Network keys with built-in presets in {@link CloudStorageNetworks}. */
export type CloudStorageEnvironment = keyof typeof CloudStorageNetworks;

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("CloudStorageNetworks", () => {
        test("paseo has a valid genesis hash", () => {
            expect(CloudStorageNetworks.paseo.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });

        test("paseo descriptor has matching genesis", () => {
            expect(CloudStorageNetworks.paseo.descriptor.genesis).toBe(
                CloudStorageNetworks.paseo.genesisHash,
            );
        });

        test("summit has a valid genesis hash", () => {
            expect(CloudStorageNetworks.summit.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });

        test("summit descriptor has matching genesis", () => {
            expect(CloudStorageNetworks.summit.descriptor.genesis).toBe(
                CloudStorageNetworks.summit.genesisHash,
            );
        });

        test("devnet has a valid genesis hash", () => {
            expect(CloudStorageNetworks.devnet.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });

        test("devnet descriptor has matching genesis", () => {
            expect(CloudStorageNetworks.devnet.descriptor.genesis).toBe(
                CloudStorageNetworks.devnet.genesisHash,
            );
        });
    });
}
