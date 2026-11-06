// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition } from "polkadot-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));

vi.mock("@parity/product-sdk-signer", async (importOriginal) => {
    const original = await importOriginal<typeof import("@parity/product-sdk-signer")>();
    class CapturingHostProvider {
        readonly type = "host";
        constructor(options: Record<string, unknown> = {}) {
            captured.options.push(options);
        }
        async connect() {
            return { ok: true as const, value: [] };
        }
        disconnect() {}
        onStatusChange() {
            return () => {};
        }
        onAccountsChange() {
            return () => {};
        }
    }
    return { ...original, HostProvider: CapturingHostProvider };
});

import { createAccountsController } from "./accounts.js";
import { defineConfig } from "./config.js";
import { createHostController } from "./host.js";

const chains = {
    test: { descriptor: {} as ChainDefinition, genesisHash: "0x11" as `0x${string}` },
};

beforeEach(() => {
    captured.options.length = 0;
});

// HostProvider falls back to getProductAccount(dappName, 0) when no explicit
// productAccount is configured; if neither reaches it, host connect() resolves
// with an empty account list and only a console warning. Pin the forwarding.
describe("HostProvider option forwarding", () => {
    it("passes dappName even without a productAccount", async () => {
        const accounts = createAccountsController(
            defineConfig({ chains, dappName: "my-dapp" }),
            createHostController(),
        );
        await accounts.connect("host").catch(() => {});
        expect(captured.options).toHaveLength(1);
        expect(captured.options[0]).toMatchObject({ dappName: "my-dapp" });
        expect(captured.options[0]).not.toHaveProperty("productAccount");
        accounts.destroy();
    });

    it("defaults dappName to product-sdk", async () => {
        const accounts = createAccountsController(defineConfig({ chains }), createHostController());
        await accounts.connect("host").catch(() => {});
        expect(captured.options[0]).toMatchObject({ dappName: "product-sdk" });
        accounts.destroy();
    });

    it("passes dappName alongside an explicit productAccount", async () => {
        const accounts = createAccountsController(
            defineConfig({
                chains,
                dappName: "my-dapp",
                productAccount: { dotNsIdentifier: "my-dapp.dot", derivationIndex: 2 },
            }),
            createHostController(),
        );
        await accounts.connect("host").catch(() => {});
        expect(captured.options[0]).toMatchObject({
            dappName: "my-dapp",
            productAccount: {
                dotNsIdentifier: "my-dapp.dot",
                derivationIndex: 2,
                requestName: false,
            },
        });
        accounts.destroy();
    });
});
