// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Errors raised by `getChainAPI` when host chain discovery
 * contradicts what the product asked for or what it bundled. Both carry
 * structured fields for programmatic handling, mirroring the shape of
 * `ChainNotSupportedError` in `@parity/product-sdk-host`.
 */

/** The environment passed to `getChainAPI` is not the one the host runs. */
export class EnvironmentMismatchError extends Error {
    /** Environment the caller asked for, e.g. `"paseo"`. */
    readonly requested: string;
    /** Network the host reports being configured for. */
    readonly hostNetwork: string;

    constructor(requested: string, hostNetwork: string) {
        super(
            `Environment mismatch: getChainAPI was called with "${requested}" but the host is configured for "${hostNetwork}". Omit the environment argument to use the host's network, or run the product on a matching host.`,
        );
        this.name = "EnvironmentMismatchError";
        this.requested = requested;
        this.hostNetwork = hostNetwork;
    }
}

/** A bundled descriptor's genesis hash disagrees with the host's answer. */
export class GenesisMismatchError extends Error {
    /** Preset chain key, e.g. `"assetHub"`. */
    readonly chain: string;
    /** Genesis hash baked into the bundled descriptor. */
    readonly descriptorGenesis: string;
    /** Genesis hash the host serves for this chain. */
    readonly hostGenesis: string;

    constructor(chain: string, descriptorGenesis: string, hostGenesis: string) {
        super(
            `Genesis hash mismatch for "${chain}": the bundled descriptor expects ${descriptorGenesis} but the host serves ${hostGenesis}. The descriptor bundle is likely stale, for example after a testnet reset. Update @parity/product-sdk-descriptors or check the host's environment.`,
        );
        this.name = "GenesisMismatchError";
        this.chain = chain;
        this.descriptorGenesis = descriptorGenesis;
        this.hostGenesis = hostGenesis;
    }
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    const cases = [
        {
            error: new EnvironmentMismatchError("paseo", "devnet"),
            name: "EnvironmentMismatchError",
            fields: { requested: "paseo", hostNetwork: "devnet" },
        },
        {
            error: new GenesisMismatchError("assetHub", "0xaaa", "0xbbb"),
            name: "GenesisMismatchError",
            fields: { chain: "assetHub", descriptorGenesis: "0xaaa", hostGenesis: "0xbbb" },
        },
    ];

    test("mismatch errors carry structured fields and name them in the message", () => {
        for (const { error, name, fields } of cases) {
            expect(error.name).toBe(name);
            for (const [field, value] of Object.entries(fields)) {
                expect((error as unknown as Record<string, string>)[field]).toBe(value);
                expect(error.message).toContain(value);
            }
        }
    });
}
