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
     */
    readonly dryRunCall: ReviveDryRunCall;
}

/**
 * Wrap a typed PAPI API as a `ContractRuntime`. Intended for tests and
 * advanced setups where the caller already holds a typed API. Routes the
 * dry-run through the typed (compatibility-token-checked) `ReviveApi.call`
 * — fine for mocks but susceptible to `Incompatible runtime entry` errors
 * on a live chain whose descriptor lags. Prefer
 * {@link createContractRuntimeFromClient} for production use.
 */
export function createContractRuntime(api: ReviveTypedApi): ContractRuntime {
    return {
        api,
        dryRunCall: (origin, dest, value, gas, deposit, data) =>
            api.apis.ReviveApi.call(origin, dest, value, gas, deposit, data),
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
): ContractRuntime {
    const typed = client.getTypedApi(
        descriptor as Parameters<PolkadotClient["getTypedApi"]>[0],
    ) as unknown as ReviveTypedApi;
    const unsafe = client.getUnsafeApi() as unknown as {
        apis: { ReviveApi: { call: ReviveDryRunCall } };
    };
    return {
        api: typed,
        dryRunCall: (origin, dest, value, gas, deposit, data) =>
            unsafe.apis.ReviveApi.call(origin, dest, value, gas, deposit, data),
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
}
