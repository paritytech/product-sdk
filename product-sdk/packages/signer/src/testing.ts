// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Test fakes for `@parity/product-sdk-signer`.
 *
 * `createFakeSignerProvider` is a controllable `SignerProvider` for
 * `new SignerManager({ createProvider: () => provider })`. Unlike `DevProvider`,
 * a test can drive it — fail a `connect()`, push status and account changes — so
 * wallet error and reconnection flows are testable in Node, no host.
 *
 * @packageDocumentation
 */
import type { PolkadotSigner } from "polkadot-api";

import { SignerError } from "./errors.js";
import type { SignerProvider } from "./providers/types.js";
import type { ConnectionStatus, ProviderType, Result, SignerAccount } from "./types.js";
import { err, ok } from "./types.js";

/** Well-known `//Alice` SS58 address, for a recognizable default account. */
const ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

/**
 * Build a {@link SignerAccount} with test defaults. Override any field.
 *
 * The stub `getSigner()` signs a fixed 64 zero bytes — enough to exercise call
 * sites, not a real signature. Override `getSigner` if a test needs real ones.
 */
export function fakeSignerAccount(overrides?: Partial<SignerAccount>): SignerAccount {
    const publicKey = overrides?.publicKey ?? new Uint8Array(32);
    return {
        address: ALICE_SS58,
        h160Address: `0x${"ee".repeat(20)}`,
        publicKey,
        name: "Alice",
        source: "dev",
        getSigner: () =>
            ({
                publicKey,
                signBytes: async () => new Uint8Array(64),
                signTx: async () => new Uint8Array(),
            }) as unknown as PolkadotSigner,
        ...overrides,
    };
}

/** A controllable {@link SignerProvider} with an inspection surface for tests. */
export interface FakeSignerProvider extends SignerProvider {
    /** Push a connection-status change to `onStatusChange` subscribers. */
    emitStatus(status: ConnectionStatus): void;
    /** Replace the account list and notify `onAccountsChange` subscribers. */
    emitAccounts(accounts: SignerAccount[]): void;
    /** Make the next `connect()` resolve to `err(error)`. */
    failConnect(error: SignerError): void;
    /** Lifecycle calls (`connect` / `disconnect`) against this provider, in order. */
    readonly calls: ReadonlyArray<{ method: string }>;
    /** Reset accounts, pending error, subscribers, and the call log. */
    reset(): void;
}

/** Options for {@link createFakeSignerProvider}. */
export interface CreateFakeSignerProviderOptions {
    /** Accounts `connect()` resolves with. Default: a single dev account. */
    accounts?: SignerAccount[];
    /** Provider type. Default `"dev"`; use `"host"` to exercise host-only paths. */
    type?: ProviderType;
}

/**
 * Create a controllable in-memory {@link SignerProvider}.
 *
 * @example
 * ```ts
 * import { SignerManager } from "@parity/product-sdk-signer";
 * import { createFakeSignerProvider } from "@parity/product-sdk-signer/testing";
 *
 * const provider = createFakeSignerProvider();
 * const manager = new SignerManager({ createProvider: () => provider, persistence: null });
 * await manager.connect("dev");
 * provider.emitStatus("disconnected"); // drive the reconnection path
 * ```
 */
export function createFakeSignerProvider(
    options?: CreateFakeSignerProviderOptions,
): FakeSignerProvider {
    const defaultAccounts = () => options?.accounts ?? [fakeSignerAccount()];
    let accounts = defaultAccounts();
    let pendingError: SignerError | null = null;
    const statusCbs = new Set<(status: ConnectionStatus) => void>();
    const accountsCbs = new Set<(accounts: SignerAccount[]) => void>();
    const calls: { method: string }[] = [];

    return {
        type: options?.type ?? "dev",
        calls,
        async connect(): Promise<Result<SignerAccount[], SignerError>> {
            calls.push({ method: "connect" });
            if (pendingError) {
                const error = pendingError;
                pendingError = null;
                return err(error);
            }
            return ok(accounts);
        },
        disconnect() {
            calls.push({ method: "disconnect" });
        },
        onStatusChange(callback) {
            statusCbs.add(callback);
            return () => {
                statusCbs.delete(callback);
            };
        },
        onAccountsChange(callback) {
            accountsCbs.add(callback);
            return () => {
                accountsCbs.delete(callback);
            };
        },
        emitStatus(status) {
            for (const cb of statusCbs) cb(status);
        },
        emitAccounts(next) {
            accounts = next;
            for (const cb of accountsCbs) cb(next);
        },
        failConnect(error) {
            pendingError = error;
        },
        reset() {
            accounts = defaultAccounts();
            pendingError = null;
            statusCbs.clear();
            accountsCbs.clear();
            calls.length = 0;
        },
    } satisfies FakeSignerProvider;
}

if (import.meta.vitest) {
    // Round-trip guard: drive the fake through the *real* `SignerManager`.
    const { describe, test, expect } = import.meta.vitest;
    const { SignerManager } = await import("./signer-manager.js");

    describe("createFakeSignerProvider", () => {
        test("connects through the real SignerManager", async () => {
            const provider = createFakeSignerProvider({
                accounts: [fakeSignerAccount({ name: "Alice" })],
            });
            const manager = new SignerManager({
                createProvider: () => provider,
                persistence: null,
            });

            const res = await manager.connect("dev");
            expect(res.ok).toBe(true);

            const state = manager.getState();
            expect(state.status).toBe("connected");
            expect(state.accounts).toHaveLength(1);
            expect(state.accounts[0].name).toBe("Alice");
        });

        test("surfaces a connect failure", async () => {
            const provider = createFakeSignerProvider();
            provider.failConnect(new SignerError("host unavailable"));
            const manager = new SignerManager({
                createProvider: () => provider,
                persistence: null,
            });

            const res = await manager.connect("dev");
            expect(res.ok).toBe(false);
        });

        test("delivers status and account emissions, and unsubscribe stops them", () => {
            const provider = createFakeSignerProvider();

            const statuses: ConnectionStatus[] = [];
            const unsub = provider.onStatusChange((s) => statuses.push(s));
            provider.emitStatus("disconnected");
            provider.emitStatus("connecting");
            unsub();
            provider.emitStatus("connected");
            expect(statuses).toEqual(["disconnected", "connecting"]);

            const seen: SignerAccount[][] = [];
            provider.onAccountsChange((a) => seen.push(a));
            const next = [fakeSignerAccount({ name: "Bob" })];
            provider.emitAccounts(next);
            expect(seen).toEqual([next]);
        });

        test("records calls and reset clears them", async () => {
            const provider = createFakeSignerProvider();
            await provider.connect();
            provider.disconnect();
            expect(provider.calls.map((c) => c.method)).toEqual(["connect", "disconnect"]);

            provider.reset();
            expect(provider.calls).toHaveLength(0);
        });
    });
}
