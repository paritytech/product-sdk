// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { seedToAccount } from "@parity/product-sdk-keys";
import { createLogger } from "@parity/product-sdk-logger";

import type { SignerError } from "../errors.js";
import type { Result, SignerAccount } from "../types.js";
import { ok } from "../types.js";
import type { SignerProvider, Unsubscribe } from "./types.js";

const log = createLogger("signer:dev");

/** The well-known Substrate development mnemonic phrase. */
const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

/** Standard Substrate dev account names. */
const DEFAULT_DEV_NAMES = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Ferdie"] as const;

/** A well-known Substrate development account name (Alice, Bob, …) used to derive deterministic dev accounts from the standard Substrate dev mnemonic. */
export type DevAccountName = (typeof DEFAULT_DEV_NAMES)[number];

/** Supported key types for dev account derivation. */
export type DevKeyType = "sr25519" | "ed25519";

/** Options for the dev account provider. */
export interface DevProviderOptions {
    /** Which dev accounts to create. Default: all 6 standard accounts. */
    names?: readonly string[];
    /** Custom mnemonic phrase instead of DEV_PHRASE. */
    mnemonic?: string;
    /** SS58 prefix for address encoding. Default: 42 */
    ss58Prefix?: number;
    /** Key type for account derivation. Default: "sr25519" */
    keyType?: DevKeyType;
}

/**
 * Provider for Substrate development accounts.
 *
 * Uses the well-known DEV_PHRASE with hard derivation paths (`//Alice`, `//Bob`, etc.)
 * to create deterministic accounts for local development and testing.
 */
export class DevProvider implements SignerProvider {
    readonly type = "dev" as const;
    private readonly names: readonly string[];
    private readonly mnemonic: string;
    private readonly ss58Prefix: number;
    private readonly keyType: DevKeyType;

    constructor(options?: DevProviderOptions) {
        this.names = options?.names ?? DEFAULT_DEV_NAMES;
        this.mnemonic = options?.mnemonic ?? DEV_PHRASE;
        this.ss58Prefix = options?.ss58Prefix ?? 42;
        this.keyType = options?.keyType ?? "sr25519";
    }

    async connect(): Promise<Result<SignerAccount[], SignerError>> {
        log.debug("creating dev accounts", { names: this.names, keyType: this.keyType });

        const accounts: SignerAccount[] = this.names.map((name) => {
            const derived = seedToAccount(
                this.mnemonic,
                `//${name}`,
                this.ss58Prefix,
                this.keyType,
            );

            return {
                address: derived.ss58Address,
                h160Address: derived.h160Address,
                publicKey: derived.publicKey,
                name,
                source: "dev" as const,
                getSigner: () => derived.signer,
            };
        });

        log.info("dev accounts ready", { count: accounts.length });
        return ok(accounts);
    }

    disconnect(): void {
        // Dev accounts are stateless — nothing to clean up.
    }

    onStatusChange(
        _callback: (status: "disconnected" | "connecting" | "connected") => void,
    ): Unsubscribe {
        // Dev accounts are always "connected" — no status changes to emit.
        return () => {};
    }

    onAccountsChange(_callback: (accounts: SignerAccount[]) => void): Unsubscribe {
        // Dev accounts are static — no account changes to emit.
        return () => {};
    }
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    // Well-known Alice address on generic substrate (prefix 42)
    const ALICE_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

    describe("DevProvider", () => {
        test("connect returns 6 accounts by default", async () => {
            const provider = new DevProvider();
            const result = await provider.connect();
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value).toHaveLength(6);
                expect(result.value.map((a) => a.name)).toEqual([
                    "Alice",
                    "Bob",
                    "Charlie",
                    "Dave",
                    "Eve",
                    "Ferdie",
                ]);
            }
        });

        test("all accounts have source 'dev'", async () => {
            const provider = new DevProvider();
            const result = await provider.connect();
            if (result.ok) {
                for (const account of result.value) {
                    expect(account.source).toBe("dev");
                }
            }
        });

        test("Alice has well-known address", async () => {
            const provider = new DevProvider();
            const result = await provider.connect();
            if (result.ok) {
                expect(result.value[0].address).toBe(ALICE_ADDRESS);
            }
        });

        test("addresses are deterministic", async () => {
            const a = new DevProvider();
            const b = new DevProvider();
            const ra = await a.connect();
            const rb = await b.connect();
            if (ra.ok && rb.ok) {
                expect(ra.value.map((x) => x.address)).toEqual(rb.value.map((x) => x.address));
            }
        });

        test("each account has 32-byte publicKey", async () => {
            const provider = new DevProvider();
            const result = await provider.connect();
            if (result.ok) {
                for (const account of result.value) {
                    expect(account.publicKey).toBeInstanceOf(Uint8Array);
                    expect(account.publicKey.length).toBe(32);
                }
            }
        });

        test("getSigner returns signer with matching publicKey", async () => {
            const provider = new DevProvider();
            const result = await provider.connect();
            if (result.ok) {
                for (const account of result.value) {
                    const signer = account.getSigner();
                    expect(signer.publicKey).toEqual(account.publicKey);
                }
            }
        });

        test("custom names subset", async () => {
            const provider = new DevProvider({ names: ["Alice", "Bob"] });
            const result = await provider.connect();
            if (result.ok) {
                expect(result.value).toHaveLength(2);
                expect(result.value.map((a) => a.name)).toEqual(["Alice", "Bob"]);
            }
        });

        test("custom mnemonic produces different addresses", async () => {
            const customMnemonic =
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
            const defaultProvider = new DevProvider();
            const customProvider = new DevProvider({ mnemonic: customMnemonic });
            const defResult = await defaultProvider.connect();
            const cusResult = await customProvider.connect();
            if (defResult.ok && cusResult.ok) {
                expect(defResult.value[0].address).not.toBe(cusResult.value[0].address);
            }
        });

        test("custom ss58Prefix changes address encoding", async () => {
            const generic = new DevProvider({ ss58Prefix: 42 });
            const polkadot = new DevProvider({ ss58Prefix: 0 });
            const rg = await generic.connect();
            const rp = await polkadot.connect();
            if (rg.ok && rp.ok) {
                // Different address strings
                expect(rg.value[0].address).not.toBe(rp.value[0].address);
                // Same underlying public key
                expect(rg.value[0].publicKey).toEqual(rp.value[0].publicKey);
            }
        });

        test("disconnect is idempotent", () => {
            const provider = new DevProvider();
            // Should not throw
            provider.disconnect();
            provider.disconnect();
        });

        test("onStatusChange returns no-op unsubscribe", () => {
            const provider = new DevProvider();
            const callback = () => {};
            const unsub = provider.onStatusChange(callback);
            expect(typeof unsub).toBe("function");
            unsub(); // should not throw
        });

        test("onAccountsChange returns no-op unsubscribe", () => {
            const provider = new DevProvider();
            const callback = () => {};
            const unsub = provider.onAccountsChange(callback);
            expect(typeof unsub).toBe("function");
            unsub(); // should not throw
        });

        test("type is 'dev'", () => {
            const provider = new DevProvider();
            expect(provider.type).toBe("dev");
        });

        test("empty names array returns zero accounts", async () => {
            const provider = new DevProvider({ names: [] });
            const result = await provider.connect();
            if (result.ok) {
                expect(result.value).toHaveLength(0);
            }
        });

        test("default keyType is sr25519 (backward compatible)", async () => {
            const provider = new DevProvider();
            const result = await provider.connect();
            if (result.ok) {
                // Alice address matches well-known sr25519 address
                expect(result.value[0].address).toBe(ALICE_ADDRESS);
            }
        });
    });

    describe("DevProvider ed25519", () => {
        test("ed25519 produces different addresses than sr25519", async () => {
            const sr = new DevProvider({ keyType: "sr25519" });
            const ed = new DevProvider({ keyType: "ed25519" });
            const srResult = await sr.connect();
            const edResult = await ed.connect();
            if (srResult.ok && edResult.ok) {
                expect(srResult.value[0].address).not.toBe(edResult.value[0].address);
            }
        });

        test("ed25519 addresses are deterministic", async () => {
            const a = new DevProvider({ keyType: "ed25519" });
            const b = new DevProvider({ keyType: "ed25519" });
            const ra = await a.connect();
            const rb = await b.connect();
            if (ra.ok && rb.ok) {
                expect(ra.value.map((x) => x.address)).toEqual(rb.value.map((x) => x.address));
            }
        });

        test("ed25519 getSigner has matching publicKey", async () => {
            const provider = new DevProvider({ keyType: "ed25519" });
            const result = await provider.connect();
            if (result.ok) {
                for (const account of result.value) {
                    const signer = account.getSigner();
                    expect(signer.publicKey).toEqual(account.publicKey);
                }
            }
        });

        test("ed25519 accounts have 32-byte publicKey", async () => {
            const provider = new DevProvider({ keyType: "ed25519" });
            const result = await provider.connect();
            if (result.ok) {
                for (const account of result.value) {
                    expect(account.publicKey).toBeInstanceOf(Uint8Array);
                    expect(account.publicKey.length).toBe(32);
                }
            }
        });
    });
}
