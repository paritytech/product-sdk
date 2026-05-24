/**
 * Known Cloud Storage networks.
 *
 * Each environment pairs its genesis hash with a per-environment PAPI descriptor.
 * Bulletin and individuality share the Paseo runtime today, but every environment
 * is a separate chain instance with its own genesis — so descriptors are now
 * generated per-environment to keep `descriptor.genesis` aligned with the live
 * chain instance the consumer connects to.
 */
import { paseo_bulletin as paseoBulletinDescriptor } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { previewnet_bulletin as previewnetBulletinDescriptor } from "@parity/product-sdk-descriptors/previewnet-bulletin";

export interface CloudStorageNetwork {
    /** Genesis hash of the underlying chain on this environment. */
    genesisHash: `0x${string}`;
    /** PAPI descriptor for typed API access. */
    descriptor: typeof paseoBulletinDescriptor | typeof previewnetBulletinDescriptor;
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
    previewnet: {
        genesisHash: "0xf37fa1f1450ea120edbf64c3fc447f671a00e1f1095a698f42eeec073c7ee487",
        descriptor: previewnetBulletinDescriptor,
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

        test("previewnet has a valid genesis hash", () => {
            expect(CloudStorageNetworks.previewnet.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });

        test("previewnet descriptor has matching genesis", () => {
            expect(CloudStorageNetworks.previewnet.descriptor.genesis).toBe(
                CloudStorageNetworks.previewnet.genesisHash,
            );
        });

        test("paseo and previewnet are distinct chain instances", () => {
            // Same runtime, separate deployments — genesis hashes must differ.
            expect(CloudStorageNetworks.previewnet.genesisHash).not.toBe(
                CloudStorageNetworks.paseo.genesisHash,
            );
        });

        test("paseo and previewnet use distinct descriptors", () => {
            // Per-environment descriptors so descriptor.genesis matches the
            // live chain instance, not a shared reference.
            expect(CloudStorageNetworks.previewnet.descriptor).not.toBe(
                CloudStorageNetworks.paseo.descriptor,
            );
        });
    });
}
