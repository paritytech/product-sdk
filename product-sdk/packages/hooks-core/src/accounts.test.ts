// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { ChainDefinition } from "polkadot-api";
import { describe, expect, it } from "vitest";
import { createAccountsController } from "./accounts.js";
import { defineConfig } from "./config.js";
import { createHostController } from "./host.js";

const config = defineConfig({
    chains: {
        test: {
            descriptor: {} as ChainDefinition,
            genesisHash: "0x11" as `0x${string}`,
        },
    },
});

// Node has no host container, so detection resolves standalone and connect()
// falls back to the real DevProvider — a full integration path without mocks.
describe("accounts (dev provider, standalone)", () => {
    it("connects and exposes dev accounts through the state store", async () => {
        const accounts = createAccountsController(config, createHostController());
        expect(accounts.state.get().status).toBe("disconnected");

        const list = await accounts.connect();
        expect(list.length).toBeGreaterThan(0);

        const state = accounts.state.get();
        expect(state.status).toBe("connected");
        expect(state.activeProvider).toBe("dev");
        expect(state.selectedAccount).not.toBeNull();
        expect(accounts.getSigner()).not.toBeNull();
        accounts.destroy();
    });

    it("shares one in-flight connect between concurrent callers", async () => {
        const accounts = createAccountsController(config, createHostController());
        const [a, b] = await Promise.all([accounts.connect(), accounts.connect()]);
        expect(a).toBe(b);
        accounts.destroy();
    });

    it("select switches the account and the signer", async () => {
        const accounts = createAccountsController(config, createHostController());
        const list = await accounts.connect();
        const target = list[1];
        if (!target) throw new Error("expected multiple dev accounts");
        const selected = accounts.select(target.address);
        expect(selected.address).toBe(target.address);
        expect(accounts.state.get().selectedAccount?.address).toBe(target.address);
        accounts.destroy();
    });

    it("select throws for unknown addresses", async () => {
        const accounts = createAccountsController(config, createHostController());
        await accounts.connect();
        expect(() => accounts.select("5NotAnAddress")).toThrow();
        accounts.destroy();
    });

    it("signRaw produces a signature with a dev account", async () => {
        const accounts = createAccountsController(config, createHostController());
        await accounts.connect();
        const signature = await accounts.signRaw(new TextEncoder().encode("hello"));
        expect(signature.length).toBeGreaterThan(0);
        accounts.destroy();
    });

    it("login resolves AlreadyConnected standalone", async () => {
        const accounts = createAccountsController(config, createHostController());
        await expect(accounts.login()).resolves.toBe("AlreadyConnected");
        accounts.destroy();
    });

    it("getUserId resolves null standalone", async () => {
        const accounts = createAccountsController(config, createHostController());
        await expect(accounts.getUserId()).resolves.toBeNull();
        accounts.destroy();
    });

    it("ensureChainSubmitPermission is a no-op standalone", async () => {
        const accounts = createAccountsController(config, createHostController());
        await expect(accounts.ensureChainSubmitPermission()).resolves.toBeUndefined();
        accounts.destroy();
    });

    it("disconnect resets state and allows reconnect", async () => {
        const accounts = createAccountsController(config, createHostController());
        await accounts.connect();
        accounts.disconnect();
        expect(accounts.state.get().status).toBe("disconnected");
        await accounts.connect();
        expect(accounts.state.get().status).toBe("connected");
        accounts.destroy();
    });
});
