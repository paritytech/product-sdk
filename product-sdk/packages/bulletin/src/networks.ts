/**
 * Known Bulletin Chain networks.
 *
 * Each environment pairs its genesis hash with a per-environment PAPI descriptor.
 * Bulletin and individuality share the Paseo runtime today, but every environment
 * is a separate chain instance with its own genesis — so descriptors are now
 * generated per-environment to keep `descriptor.genesis` aligned with the live
 * chain instance the consumer connects to.
 */
import { paseo_bulletin as paseoBulletinDescriptor } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { previewnet_bulletin as previewnetBulletinDescriptor } from "@parity/product-sdk-descriptors/previewnet-bulletin";

export interface BulletinNetwork {
    /** Genesis hash of the bulletin chain on this environment. */
    genesisHash: `0x${string}`;
    /** PAPI descriptor for typed API access. */
    descriptor: typeof paseoBulletinDescriptor | typeof previewnetBulletinDescriptor;
}

/**
 * Bulletin Chain network presets.
 *
 * Use these with {@link BulletinClient.create} when you want to be explicit
 * about the network rather than passing an environment string. Reads go
 * through the host's preimage subscription (container-only); no gateway
 * URL is configured per network.
 */
export const BulletinChain = {
    paseo: {
        genesisHash: "0x744960c32e3a3df5440e1ecd4d34096f1ce2230d7016a5ada8a765d5a622b4ea",
        descriptor: paseoBulletinDescriptor,
    },
    previewnet: {
        genesisHash: "0xf37fa1f1450ea120edbf64c3fc447f671a00e1f1095a698f42eeec073c7ee487",
        descriptor: previewnetBulletinDescriptor,
    },
} as const satisfies Record<string, BulletinNetwork>;

/** Network keys with built-in presets in {@link BulletinChain}. */
export type BulletinEnvironment = keyof typeof BulletinChain;

if (import.meta.vitest) {
    const { describe, test, expect } = import.meta.vitest;

    describe("BulletinChain", () => {
        test("paseo has a valid genesis hash", () => {
            expect(BulletinChain.paseo.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });

        test("paseo descriptor has matching genesis", () => {
            expect(BulletinChain.paseo.descriptor.genesis).toBe(BulletinChain.paseo.genesisHash);
        });

        test("previewnet has a valid genesis hash", () => {
            expect(BulletinChain.previewnet.genesisHash).toMatch(/^0x[a-f0-9]{64}$/);
        });

        test("previewnet descriptor has matching genesis", () => {
            expect(BulletinChain.previewnet.descriptor.genesis).toBe(
                BulletinChain.previewnet.genesisHash,
            );
        });

        test("paseo and previewnet are distinct chain instances", () => {
            // Same runtime, separate deployments — genesis hashes must differ.
            expect(BulletinChain.previewnet.genesisHash).not.toBe(BulletinChain.paseo.genesisHash);
        });

        test("paseo and previewnet use distinct descriptors", () => {
            // Per-environment descriptors so descriptor.genesis matches the
            // live chain instance, not a shared reference.
            expect(BulletinChain.previewnet.descriptor).not.toBe(BulletinChain.paseo.descriptor);
        });
    });
}
