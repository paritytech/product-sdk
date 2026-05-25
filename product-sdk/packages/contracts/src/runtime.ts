import type { HexString, PolkadotClient, PolkadotSigner, SS58String } from "polkadot-api";
import type { SubmittableTransaction, Weight, TxResult } from "@parity/product-sdk-tx";
import { ensureAccountMapped } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";

/**
 * Result of a `Revive.call` extrinsic — present on the typed API as
 * `api.tx.Revive.call(args)`. Returned object is a PAPI submittable that
 * `submitAndWatch` consumes natively.
 *
 * `dest` is an H160 hex string and `data` is a raw `Uint8Array`: this matches
 * what `polkadot-api` ≥2.0 codecs accept and produce. The class-based
 * `Binary` / `FixedSizeBinary` wrappers from `@polkadot-api/substrate-bindings`
 * 0.12 are *not* accepted by PAPI 2.x's compatibility check.
 */
export type ReviveCallTx = (args: {
    dest: HexString;
    value: bigint;
    weight_limit: Weight;
    storage_deposit_limit: bigint;
    data: Uint8Array;
}) => SubmittableTransaction;

/**
 * Dry-run result returned by `ReviveApi.call`. Mirrors the shape exposed by
 * descriptors (`paseo-asset-hub`, `polkadot-asset-hub`, `kusama-asset-hub`).
 *
 * `data` is a raw `Uint8Array` because PAPI ≥2.0 dropped the `Binary` class
 * wrapper for `Vec<u8>` codecs.
 */
export interface ReviveDryRunResult {
    weight_consumed: Weight;
    weight_required: Weight;
    storage_deposit: { type: "Refund" | "Charge"; value: bigint };
    max_storage_deposit: { type: "Refund" | "Charge"; value: bigint };
    gas_consumed: bigint;
    /**
     * `success: true` carries `{ flags, data }`; `success: false` carries the
     * dispatch error as the chain encoded it.
     */
    result:
        | { success: true; value: { flags: number; data: Uint8Array } }
        | { success: false; value: unknown };
}

/**
 * Block reference used to target `ReviveApi.call` dry-runs. Matches PAPI's
 * runtime-call `at` option: `"best"`, `"finalized"`, or a block hash.
 */
export type ContractDryRunAt = "best" | "finalized" | HexString;

/**
 * Per-call options accepted by {@link ReviveDryRunCall}.
 *
 * Note on the trailing `options` arg: pallet-revive's Rust runtime API
 * `ReviveApi::call` only takes the 6 positional args (origin, dest, value,
 * gas_limit, storage_deposit_limit, input_data). This 7th `options` object
 * is **injected by PAPI** on every `api.apis.X.Y` runtime-API call via its
 * `WithCallOptions` type wrapper (see
 * `polkadot-api/packages/client/src/viewFns.ts:9-11` upstream — defined
 * as `WithCallOptions$2` in the bundled `.d.ts` due to TS bundler suffixing).
 * It never reaches the Rust side — PAPI's `viewFns.ts:38-41` consumes it in
 * JS, reads `options.at`, resolves it to a concrete block hash via the
 * chain-head's runtime context, and uses that hash on the JSON-RPC
 * `state_call` invocation. The 6-arg payload sent over the wire is
 * unchanged.
 */
export interface ReviveDryRunCallOptions {
    at?: ContractDryRunAt;
}

/** Structural shape consumed by `ContractManager` / `createContract`. */
export interface ReviveTypedApi {
    tx: {
        Revive: {
            call: ReviveCallTx;
            map_account(): SubmittableTransaction;
        };
    };
    query: {
        Revive: {
            OriginalAccount: {
                getValue(address: HexString): Promise<SS58String | undefined>;
            };
        };
    };
    apis: {
        ReviveApi: {
            call(
                origin: SS58String,
                dest: HexString,
                value: bigint,
                gas_limit: Weight | undefined,
                storage_deposit_limit: bigint | undefined,
                input_data: Uint8Array,
                options?: ReviveDryRunCallOptions,
            ): Promise<ReviveDryRunResult>;
        };
    };
}

/**
 * Signature of a `ReviveApi.call` dry-run, used by the wrapped contract layer
 * to estimate weight + storage deposit and surface revert / OOG /
 * `AccountNotMapped` failures before a tx is signed.
 *
 * Identical to `ReviveTypedApi.apis.ReviveApi.call`, but extracted so the
 * runtime can route this single hot call through PAPI's *unsafe* API
 * (skipping compatibility-token checks) on production runtimes whose
 * descriptors lag a chain upgrade — every other surface still uses the
 * compat-checked typed API.
 */
export type ReviveDryRunCall = (
    origin: SS58String,
    dest: HexString,
    value: bigint,
    gas_limit: Weight | undefined,
    storage_deposit_limit: bigint | undefined,
    input_data: Uint8Array,
    options?: ReviveDryRunCallOptions,
) => Promise<ReviveDryRunResult>;

/**
 * Runtime handle that drives queries and transactions against a
 * pallet-revive-capable chain.
 *
 * @example
 * ```ts
 * import { createChainClient } from "@parity/product-sdk-chain-client";
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
 *
 * const client = await createChainClient({
 *     chains: { assetHub: paseo_asset_hub },
 *     rpcs: { assetHub: ["wss://paseo-asset-hub-next-rpc.polkadot.io"] },
 * });
 * const runtime = createContractRuntimeFromClient(client.raw.assetHub, paseo_asset_hub);
 * ```
 */
export interface ContractRuntime {
    readonly api: ReviveTypedApi;
    /**
     * Dry-run entry point. Production factories route this through the
     * *unsafe* API to avoid compatibility-token failures when the descriptor
     * trails a runtime upgrade. The {@link createContractRuntime} test factory
     * delegates to `api.apis.ReviveApi.call`.
     *
     * The runtime default `at` (set via {@link ContractRuntimeOptions.at} on
     * the factory) is applied when the caller does not pass an explicit
     * `options.at`. `.query()` per-call overrides flow through this argument.
     */
    readonly dryRunCall: ReviveDryRunCall;
}

/** Options for {@link createContractRuntime} / {@link createContractRuntimeFromClient}. */
export interface ContractRuntimeOptions {
    /**
     * Block to target for `ReviveApi.call` dry-runs. Defaults to `"best"`
     * so contract `.query()` reads observe the same state as transactions
     * resolved at best-block (the product-sdk `.tx()` default). Set to
     * `"finalized"` to read the canonical, lagged state, or to a specific
     * block hash to pin reads to a historical block. Can be overridden per
     * call via `QueryOptions.at`.
     */
    at?: ContractDryRunAt;
}

/**
 * Wrap a typed PAPI API as a `ContractRuntime`. Intended for tests and
 * advanced setups where the caller already holds a typed API. Routes the
 * dry-run through the typed (compatibility-token-checked) `ReviveApi.call`
 * — fine for mocks but susceptible to `Incompatible runtime entry` errors
 * on a live chain whose descriptor lags. Prefer
 * {@link createContractRuntimeFromClient} for production use.
 */
export function createContractRuntime(
    api: ReviveTypedApi,
    options?: ContractRuntimeOptions,
): ContractRuntime {
    const defaultAt: ContractDryRunAt = options?.at ?? "best";
    return {
        api,
        dryRunCall: (origin, dest, value, gas, deposit, data, callOpts) =>
            api.apis.ReviveApi.call(origin, dest, value, gas, deposit, data, {
                at: callOpts?.at ?? defaultAt,
            }),
    };
}

/**
 * Build a `ContractRuntime` from a raw `PolkadotClient` plus its descriptor.
 *
 * The typed API powers `tx.Revive.call`, `tx.Revive.map_account`, and
 * `query.Revive.OriginalAccount` (extrinsics + storage are tolerant of
 * descriptor drift). The runtime-API dry-run, which is *not* tolerant of
 * descriptor drift on PAPI's compat-token path, is routed through
 * `client.getUnsafeApi()` — bypassing the compat check while preserving
 * argument and return shapes.
 *
 * Use this on every production code path that calls a contract's `.tx()` or
 * `.query()` against a live chain.
 *
 * @example
 * ```ts
 * import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
 * import { createContractRuntimeFromClient } from "@parity/product-sdk-contracts";
 *
 * const runtime = createContractRuntimeFromClient(rawClient, paseo_asset_hub);
 * ```
 */
export function createContractRuntimeFromClient<TDescriptor>(
    client: PolkadotClient,
    descriptor: TDescriptor,
    options?: ContractRuntimeOptions,
): ContractRuntime {
    const defaultAt: ContractDryRunAt = options?.at ?? "best";
    const typed = client.getTypedApi(
        descriptor as Parameters<PolkadotClient["getTypedApi"]>[0],
    ) as unknown as ReviveTypedApi;
    const unsafe = client.getUnsafeApi() as unknown as {
        apis: { ReviveApi: { call: ReviveDryRunCall } };
    };
    return {
        api: typed,
        dryRunCall: (origin, dest, value, gas, deposit, data, callOpts) =>
            unsafe.apis.ReviveApi.call(origin, dest, value, gas, deposit, data, {
                at: callOpts?.at ?? defaultAt,
            }),
    };
}

/**
 * Ensure the SS58 account is mapped to its derived H160 on `pallet-revive`.
 *
 * `pallet-revive` requires every signing account to have a registered
 * `OriginalAccount` mapping before the runtime accepts its `Revive.call`
 * extrinsics. The mapping is one-time and cheap. This helper:
 *
 *   1. Reads `Revive.OriginalAccount` for the H160 derived from `address`.
 *   2. Returns `null` if already mapped (idempotent fast-path).
 *   3. Otherwise submits `Revive.map_account()` and waits for inclusion.
 *
 * Call this once per signing account at app startup — after that, every
 * subsequent `contract.<method>.tx({ signer })` against the same chain will
 * succeed without further mapping work.
 *
 * @param runtime - The contract runtime (typically `createContractRuntime(...)`).
 * @param address - The SS58 address of the account to map.
 * @param signer - A signer matching `address`.
 * @param options - Optional timeout / status callback (forwarded to the underlying tx).
 * @returns The `TxResult` from the mapping extrinsic, or `null` if already mapped.
 *
 * @example
 * ```ts
 * import { createContractRuntime, ensureContractAccountMapped } from "@parity/product-sdk-contracts";
 *
 * const runtime = createContractRuntime(client.getTypedApi(paseo_asset_hub));
 * await ensureContractAccountMapped(runtime, signerManager.getState().selectedAccount!.address, signer);
 * // now safe to call contract.<method>.tx({ signer })
 * ```
 */
export async function ensureContractAccountMapped(
    runtime: ContractRuntime,
    address: SS58String,
    signer: PolkadotSigner,
    options?: { timeoutMs?: number; onStatus?: (s: string) => void },
): Promise<TxResult | null> {
    const checker = {
        addressIsMapped: async (addr: string): Promise<boolean> => {
            const h160 = ss58ToH160(addr) as HexString;
            return (await runtime.api.query.Revive.OriginalAccount.getValue(h160)) !== undefined;
        },
    };
    return ensureAccountMapped(address, signer, checker, runtime.api, options);
}

if (import.meta.vitest) {
    const { test, expect, describe, vi } = import.meta.vitest;

    describe("ensureContractAccountMapped", () => {
        // Pin the wiring: storage hit ⇒ short-circuit to null without
        // submitting; H160 (not SS58) is what reaches the storage query.
        const aliceSs58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;
        const fakeSigner = { publicKey: new Uint8Array(32) } as unknown as PolkadotSigner;

        function makeRuntime(opts: {
            mapped: boolean;
            mapAccount?: () => SubmittableTransaction;
        }): {
            runtime: ContractRuntime;
            getValue: ReturnType<typeof vi.fn>;
            mapAccount: ReturnType<typeof vi.fn>;
        } {
            const getValue = vi.fn(async () =>
                opts.mapped ? ("5mappedSs58" as SS58String) : undefined,
            );
            const mapAccount = vi.fn(() => {
                if (opts.mapAccount) return opts.mapAccount();
                throw new Error("map_account must NOT be invoked when address is already mapped");
            });
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: () => {
                                throw new Error("Revive.call is unrelated to mapping");
                            },
                            map_account: mapAccount,
                        },
                    },
                    query: {
                        Revive: {
                            OriginalAccount: { getValue },
                        },
                    },
                    apis: {
                        ReviveApi: {
                            call: () => {
                                throw new Error("ReviveApi.call is unrelated to mapping");
                            },
                        },
                    },
                } as unknown as ReviveTypedApi,
                dryRunCall: () => {
                    throw new Error("dryRunCall is unrelated to mapping");
                },
            };
            return { runtime, getValue, mapAccount };
        }

        test("returns null without submitting when storage already has the mapping", async () => {
            const { runtime, getValue, mapAccount } = makeRuntime({ mapped: true });
            const result = await ensureContractAccountMapped(runtime, aliceSs58, fakeSigner);

            expect(result).toBeNull();
            // The H160 derivation hands a `0x…` hex string to the storage
            // query — not the SS58 address. If the wiring ever forwards the
            // SS58 by accident, this assertion catches it.
            expect(getValue).toHaveBeenCalledTimes(1);
            const passedAddress = getValue.mock.calls[0][0] as string;
            expect(passedAddress.startsWith("0x")).toBe(true);
            expect(passedAddress.length).toBe(2 + 40);
            expect(mapAccount).not.toHaveBeenCalled();
        });
    });

    describe("createContractRuntime — at-block routing", () => {
        // The contract is: a `.query()` against the runtime resolves at
        // best-block by default so it observes the same state as `.tx()` /
        // `batchSubmitAndWatch()` (which resolve at best-block). Callers can
        // override per call. These tests pin both behaviours by capturing the
        // options that arrive at the underlying `ReviveApi.call`.
        const origin = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;
        const dest = "0x0102030405060708090a0b0c0d0e0f1011121314" as HexString;

        function makeApi(): {
            api: ReviveTypedApi;
            calls: Array<unknown[]>;
        } {
            const calls: Array<unknown[]> = [];
            const api = {
                apis: {
                    ReviveApi: {
                        call: (...args: unknown[]) => {
                            calls.push(args);
                            return Promise.resolve({
                                weight_consumed: { ref_time: 0n, proof_size: 0n },
                                weight_required: { ref_time: 1n, proof_size: 1n },
                                storage_deposit: { type: "Refund", value: 0n },
                                max_storage_deposit: { type: "Refund", value: 0n },
                                gas_consumed: 0n,
                                result: {
                                    success: true,
                                    value: { flags: 0, data: new Uint8Array(0) },
                                },
                            });
                        },
                    },
                },
            } as unknown as ReviveTypedApi;
            return { api, calls };
        }

        test("defaults to `at: best` when no option is passed to the factory", async () => {
            const { api, calls } = makeApi();
            const runtime = createContractRuntime(api);
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0));
            expect(calls[0]?.[6]).toEqual({ at: "best" });
        });

        test("respects an explicit factory default", async () => {
            const { api, calls } = makeApi();
            const runtime = createContractRuntime(api, { at: "finalized" });
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0));
            expect(calls[0]?.[6]).toEqual({ at: "finalized" });
        });

        test("per-call `at` option overrides the factory default", async () => {
            const { api, calls } = makeApi();
            const runtime = createContractRuntime(api, { at: "best" });
            const blockHash = `0x${"ab".repeat(32)}` as HexString;
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0), {
                at: blockHash,
            });
            expect(calls[0]?.[6]).toEqual({ at: blockHash });
        });

        test("explicit per-call `at: best` is forwarded even when factory default is `finalized`", async () => {
            const { api, calls } = makeApi();
            const runtime = createContractRuntime(api, { at: "finalized" });
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0), {
                at: "best",
            });
            expect(calls[0]?.[6]).toEqual({ at: "best" });
        });
    });

    describe("createContractRuntimeFromClient — at-block routing", () => {
        // The production factory has its own (parallel) `at` plumbing
        // through `getUnsafeApi()`. A regression in this branch would slip
        // past the typed-API tests above, so we mock the client and pin the
        // same contract: factory default applied, per-call override wins.
        const origin = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;
        const dest = "0x0102030405060708090a0b0c0d0e0f1011121314" as HexString;

        function makeClient(): {
            client: PolkadotClient;
            calls: Array<unknown[]>;
        } {
            const calls: Array<unknown[]> = [];
            const unsafe = {
                apis: {
                    ReviveApi: {
                        call: (...args: unknown[]) => {
                            calls.push(args);
                            return Promise.resolve({
                                weight_consumed: { ref_time: 0n, proof_size: 0n },
                                weight_required: { ref_time: 1n, proof_size: 1n },
                                storage_deposit: { type: "Refund", value: 0n },
                                max_storage_deposit: { type: "Refund", value: 0n },
                                gas_consumed: 0n,
                                result: {
                                    success: true,
                                    value: { flags: 0, data: new Uint8Array(0) },
                                },
                            });
                        },
                    },
                },
            };
            const client = {
                getTypedApi: () => ({}) as never,
                getUnsafeApi: () => unsafe,
            } as unknown as PolkadotClient;
            return { client, calls };
        }

        test("defaults to `at: best` when no factory option is set", async () => {
            const { client, calls } = makeClient();
            const runtime = createContractRuntimeFromClient(client, {});
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0));
            expect(calls[0]?.[6]).toEqual({ at: "best" });
        });

        test("respects an explicit factory default", async () => {
            const { client, calls } = makeClient();
            const runtime = createContractRuntimeFromClient(client, {}, { at: "finalized" });
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0));
            expect(calls[0]?.[6]).toEqual({ at: "finalized" });
        });

        test("per-call `at` overrides factory default through the unsafe-API path", async () => {
            const { client, calls } = makeClient();
            const runtime = createContractRuntimeFromClient(client, {}, { at: "best" });
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0), {
                at: "finalized",
            });
            expect(calls[0]?.[6]).toEqual({ at: "finalized" });
        });

        test("explicit per-call `at: best` is forwarded even when factory default is `finalized`", async () => {
            const { client, calls } = makeClient();
            const runtime = createContractRuntimeFromClient(client, {}, { at: "finalized" });
            await runtime.dryRunCall(origin, dest, 0n, undefined, undefined, new Uint8Array(0), {
                at: "best",
            });
            expect(calls[0]?.[6]).toEqual({ at: "best" });
        });
    });
}
