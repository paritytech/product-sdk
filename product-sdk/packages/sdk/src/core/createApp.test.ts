// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    it,
    vi,
    type MockInstance,
} from "vitest";
import { errAsync, okAsync } from "neverthrow";
import { HostUnavailableError, type TruApi } from "@parity/product-sdk-host";
import {
    createFakeHost,
    createFakeTruApiClient,
    setTruApiClient,
} from "@parity/product-sdk-host/testing";
import { configure, type LogEntry } from "@parity/product-sdk-logger";
import { createApp } from "./createApp.js";
import type { App } from "./types.js";
import type { ProductSDKProviderProps } from "../react/provider.js";

describe("host-derived app identity", () => {
    let client: TruApi;
    let entries: LogEntry[];
    const apps: App[] = [];
    let getProductContext: MockInstance<TruApi["system"]["getProductContext"]>;

    beforeEach(() => {
        client = createFakeTruApiClient({ productId: "session.paseo" });
        getProductContext = vi.spyOn(client.system, "getProductContext");
        setTruApiClient(client);
        entries = [];
        configure({ level: "warn", namespaces: [], handler: (entry) => entries.push(entry) });
    });

    afterEach(async () => {
        for (const app of apps.splice(0)) await app.wallet.disconnect();
        setTruApiClient(null);
        vi.restoreAllMocks();
    });

    it("works with the public fake host without overriding protocol methods", async () => {
        using host = createFakeHost();
        const app = await createApp({ cloudStorage: false });
        apps.push(app);
        const { accounts } = await app.wallet.connect();
        await app.localStorage.set("key", "value");
        expect({
            info: app.getAppInfo(),
            accountCount: accounts.length,
            stored: (
                await host.client.localStorage.read({ key: "fake-app.dot:key" })
            )._unsafeUnwrap(),
        }).toEqual({
            info: { name: "fake-app.dot", cloudStorage: false },
            accountCount: 1,
            stored: { value: "0x76616c7565" },
        });
    });

    it.each(["session.paseo", "nested.app.dot", "localhost", "localhost:3000"])(
        "uses the exact host identity %s for wallet accounts and storage",
        async (productId) => {
            getProductContext.mockReturnValue(okAsync({ productId }));
            const getAccount = vi.spyOn(client.account, "getAccount");
            const write = vi.spyOn(client.localStorage, "write");
            const app = await createApp({ cloudStorage: false });
            apps.push(app);
            const { accounts } = await app.wallet.connect();
            await app.localStorage.set("key", "value");
            const name: string = app.getAppInfo().name;

            expect({
                name,
                accountCount: accounts.length,
                accountRequests: getAccount.mock.calls,
                storageWrite: write.mock.calls.at(-1),
                stored: await app.localStorage.get("key"),
            }).toEqual({
                name: productId,
                accountCount: 1,
                accountRequests: [
                    [
                        {
                            productAccountId: {
                                dotNsIdentifier: productId,
                                derivationIndex: { tag: "Index", value: 0 },
                            },
                        },
                    ],
                ],
                storageWrite: [{ key: `${productId}:key`, value: "0x76616c7565" }],
                stored: "value",
            });
        },
    );

    it("requests the host identity without configuration or a deprecation warning", async () => {
        expectTypeOf({ children: null }).toMatchTypeOf<ProductSDKProviderProps>();
        const error = { tag: "Unsupported" } as const;
        getProductContext.mockReturnValue(errAsync(error));
        await expect(createApp()).rejects.toMatchObject({
            name: "HostCallFailedError",
            cause: error,
        });
        expect(entries.filter((entry) => entry.namespace === "app")).toEqual([]);
    });

    it.each(["wrong-app", ""])("ignores and warns about the deprecated name %j", async (name) => {
        const app = await createApp({ name, cloudStorage: false });
        apps.push(app);
        await app.localStorage.set("key", "retained");
        const unnamed = await createApp({ cloudStorage: false });
        apps.push(unnamed);
        expect({
            info: app.getAppInfo(),
            storedWithoutName: await unnamed.localStorage.get("key"),
            warnings: entries
                .filter((entry) => entry.namespace === "app")
                .map(({ level, message }) => ({ level, message })),
        }).toEqual({
            info: { name: "session.paseo", cloudStorage: false },
            storedWithoutName: "retained",
            warnings: [
                {
                    level: "warn",
                    message:
                        "createApp: name is deprecated and ignored; the host product ID is used.",
                },
            ],
        });
    });

    it("rejects unavailable hosts even when a deprecated name is supplied", async () => {
        setTruApiClient(null);
        await expect(createApp({ name: "fallback", cloudStorage: false })).rejects.toBeInstanceOf(
            HostUnavailableError,
        );
    });

    it("preserves a refused context instead of using the deprecated name", async () => {
        const error = { tag: "Unsupported" } as const;
        getProductContext.mockReturnValue(errAsync(error));
        await expect(createApp({ name: "fallback", cloudStorage: false })).rejects.toMatchObject({
            name: "HostCallFailedError",
            message: "system.getProductContext: Unsupported",
            payload: error,
            cause: error,
        });
    });

    it("preserves a context transport rejection", async () => {
        const error = new Error("host connection closed");
        getProductContext.mockImplementation(() =>
            okAsync(undefined).map(() => {
                throw error;
            }),
        );
        await expect(createApp({ cloudStorage: false })).rejects.toBe(error);
    });
});
