/**
 * Known Bulletin Chain networks.
 *
 * Pairs each environment with the genesis hash and the PAPI descriptor needed
 * to construct an `AsyncBulletinClient`. Re-uses the descriptor exported by
 * `@parity/product-sdk-descriptors/bulletin` — the bulletin descriptor is the
 * same across all environments today, so the difference between entries is
 * the genesis hash (and, downstream, the chain RPC URL).
 */
import { bulletin as bulletinDescriptor } from "@parity/product-sdk-descriptors/bulletin";

export interface BulletinNetwork {
    /** Genesis hash of the bulletin chain on this environment. */
    genesisHash: `0x${string}`;
    /** PAPI descriptor for typed API access. */
    descriptor: typeof bulletinDescriptor;
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
        descriptor: bulletinDescriptor,
    },
    previewnet: {
        genesisHash: "0xf37fa1f1450ea120edbf64c3fc447f671a00e1f1095a698f42eeec073c7ee487",
        descriptor: bulletinDescriptor,
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

        test("paseo and previewnet are distinct chain instances", () => {
            // Same runtime, separate deployments — genesis hashes must differ.
            expect(BulletinChain.previewnet.genesisHash).not.toBe(BulletinChain.paseo.genesisHash);
        });

        test("paseo and previewnet share the bulletin descriptor", () => {
            // Bulletin runtime is identical across environments today; only the
            // chain instance (genesis) differs. If the descriptor ever needs to
            // diverge, this assertion will catch it.
            expect(BulletinChain.previewnet.descriptor).toBe(BulletinChain.paseo.descriptor);
        });
    });
}
