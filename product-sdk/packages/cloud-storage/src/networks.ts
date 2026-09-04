// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Known Cloud Storage networks.
 *
 * Each environment pairs its genesis hash with a per-environment PAPI descriptor.
 */
import { paseo_bulletin as paseoBulletinDescriptor } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { previewnet_bulletin as previewnetBulletinDescriptor } from "@parity/product-sdk-descriptors/previewnet-bulletin";
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
        genesisHash: paseoBulletinDescriptor.genesis as `0x${string}`,
        descriptor: paseoBulletinDescriptor,
    },
    previewnet: {
        genesisHash: previewnetBulletinDescriptor.genesis as `0x${string}`,
        // Previewnet Bulletin runs the same Bulletin runtime as Paseo but is a
        // separate deployment with its own genesis; the descriptor type is
        // pinned to the canonical Paseo one so the network interface stays
        // uniform across environments.
        descriptor: previewnetBulletinDescriptor as typeof paseoBulletinDescriptor,
    },
    devnet: {
        genesisHash: devnetBulletinDescriptor.genesis as `0x${string}`,
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

        test("previewnet has a valid genesis hash", () => {
            expect(CloudStorageNetworks.previewnet.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });

        test("devnet has a valid genesis hash", () => {
            expect(CloudStorageNetworks.devnet.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });
    });
}
