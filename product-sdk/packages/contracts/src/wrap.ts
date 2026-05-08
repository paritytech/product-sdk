import type { HexString, PolkadotSigner, SS58String } from "polkadot-api";
import { encodeFunctionData, decodeFunctionResult, type Abi as ViemAbi } from "viem";
import { submitAndWatch } from "@parity/product-sdk-tx";
import { seedToAccount } from "@parity/product-sdk-keys";
import { createLogger } from "@parity/product-sdk-logger";
import { DEV_PHRASE, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { ContractSignerMissingError, ContractDryRunFailedError } from "./errors.js";
import type { ContractRuntime } from "./runtime.js";
import type {
    AbiEntry,
    Contract,
    ContractDef,
    ContractDefaults,
    QueryOptions,
    QueryResult,
    TxOptions,
} from "./types.js";

const log = createLogger("contracts");

/** Map of method name → ordered ABI parameter names. */
function buildMethodArgMap(abi: AbiEntry[]): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const entry of abi) {
        if (entry.type === "function" && entry.name) {
            map[entry.name] = entry.inputs.map((p) => p.name);
        }
    }
    return map;
}

/**
 * If the caller passed more arguments than the ABI expects and the last
 * argument is a plain object, treat it as an options override.
 */
function extractOverrides<T>(
    argNames: string[],
    args: unknown[],
): { positionalArgs: unknown[]; overrides?: T } {
    if (args.length > argNames.length && args.length > 0) {
        const last = args[args.length - 1];
        if (last && typeof last === "object" && !Array.isArray(last)) {
            return { positionalArgs: args.slice(0, -1), overrides: last as T };
        }
    }
    return { positionalArgs: args };
}

/**
 * Dev address (Alice) used as fallback origin for read-only queries when no
 * wallet is connected. Queries are dry-run simulations — the origin only
 * affects gas estimation and is safe to stub.
 */
const QUERY_FALLBACK_ORIGIN = seedToAccount(DEV_PHRASE, "//Alice").ss58Address as SS58String;

function resolveOrigin(
    defaults: ContractDefaults,
    override?: SS58String,
    forQuery?: boolean,
): SS58String | undefined {
    if (override) return override;
    const sourceAddr = defaults.signerManager?.getState().selectedAccount?.address;
    if (sourceAddr) return sourceAddr as SS58String;
    if (defaults.origin) return defaults.origin;
    if (forQuery) {
        log.warn("No origin configured — using dev fallback (Alice) for query dry-run");
        return QUERY_FALLBACK_ORIGIN;
    }
    return undefined;
}

function resolveSigner(
    defaults: ContractDefaults,
    override?: PolkadotSigner,
): PolkadotSigner | undefined {
    return override ?? defaults.signerManager?.getSigner() ?? defaults.signer;
}

/**
 * Normalise a contract address to a `0x`-prefixed 20-byte hex string —
 * the shape PAPI ≥2.0 codecs and compat checks accept for `[u8; 20]` args.
 * Accepts the prefix being absent and re-adds it.
 */
function normalizeContractAddress(address: string): HexString {
    const hex = address.startsWith("0x") ? address.slice(2) : address;
    if (hex.length !== 40) {
        throw new Error(`Expected 20-byte H160 contract address, got ${hex.length / 2} bytes`);
    }
    return `0x${hex.toLowerCase()}` as HexString;
}

/** Convert a `0x`-prefixed hex string to a `Uint8Array`. */
function hexToBytes(hex: HexString): Uint8Array {
    const stripped = hex.slice(2);
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/**
 * Encode the calldata for a contract method using the Solidity ABI codec.
 * Returns `selector ‖ head ‖ tail` as a `0x`-prefixed hex string.
 */
function encodeCalldata(abi: AbiEntry[], methodName: string, args: unknown[]): `0x${string}` {
    return encodeFunctionData({
        abi: abi as unknown as ViemAbi,
        functionName: methodName,
        args,
    });
}

/**
 * Decode a successful query's return data via the Solidity ABI codec.
 * Returns `undefined` for void methods.
 */
function decodeReturn(abi: AbiEntry[], methodName: string, returnData: Uint8Array): unknown {
    if (returnData.byteLength === 0) return undefined;
    let hex = "0x";
    for (let i = 0; i < returnData.byteLength; i++) {
        hex += returnData[i].toString(16).padStart(2, "0");
    }
    return decodeFunctionResult({
        abi: abi as unknown as ViemAbi,
        functionName: methodName,
        data: hex as `0x${string}`,
    });
}

/**
 * Build a typed contract handle backed by direct `Revive` extrinsic +
 * `ReviveApi` runtime API calls. The Solidity ABI codec runs through `viem`.
 *
 * @param runtime - A `ContractRuntime` (returned by `createContractRuntime`).
 * @param address - The H160 address of the deployed contract.
 * @param abi - The Solidity ABI for the contract.
 * @param defaults - Origin / signer fallbacks shared across all method calls.
 */
export function wrapContract(
    runtime: ContractRuntime,
    address: string,
    abi: AbiEntry[],
    defaults: ContractDefaults,
): Contract<ContractDef> {
    const methodArgs = buildMethodArgMap(abi);
    const dest = normalizeContractAddress(address);

    return new Proxy({} as Record<string, unknown>, {
        get(_, methodName: string) {
            if (typeof methodName !== "string") return undefined;
            const argNames = methodArgs[methodName];
            if (!argNames) return undefined;

            return {
                query: async (...args: unknown[]): Promise<QueryResult<unknown>> => {
                    const { positionalArgs, overrides } = extractOverrides<QueryOptions>(
                        argNames,
                        args,
                    );
                    const origin = resolveOrigin(defaults, overrides?.origin, true)!;
                    const value = overrides?.value ?? 0n;

                    const calldata = hexToBytes(encodeCalldata(abi, methodName, positionalArgs));

                    const dryRun = await runtime.dryRunCall(
                        origin,
                        dest,
                        value,
                        undefined,
                        undefined,
                        calldata,
                    );

                    if (!dryRun.result.success) {
                        return {
                            success: false,
                            value: undefined,
                            gasRequired: dryRun.weight_required,
                        };
                    }

                    const decoded = decodeReturn(abi, methodName, dryRun.result.value.data);
                    return {
                        success: true,
                        value: decoded,
                        gasRequired: dryRun.weight_required,
                    };
                },

                tx: async (...args: unknown[]) => {
                    const { positionalArgs, overrides } = extractOverrides<TxOptions>(
                        argNames,
                        args,
                    );
                    const signer = resolveSigner(defaults, overrides?.signer);
                    if (!signer) {
                        throw new ContractSignerMissingError();
                    }

                    const origin =
                        resolveOrigin(defaults, overrides?.origin) ??
                        (ss58Address(signer.publicKey) as SS58String);

                    const value = overrides?.value ?? 0n;
                    const calldata = hexToBytes(encodeCalldata(abi, methodName, positionalArgs));

                    // Dry-run for weight + storage deposit unless the caller
                    // supplied explicit overrides for both. We dry-run even
                    // when both are provided would be wasteful, but if either
                    // is missing we use the dry-run to fill it in AND to fail
                    // fast on revert / OOG / AccountNotMapped — the caller
                    // shouldn't pay gas on a tx the chain already rejected.
                    let weightLimit = overrides?.gasLimit;
                    let storageDepositLimit = overrides?.storageDepositLimit;
                    if (!weightLimit || storageDepositLimit === undefined) {
                        const dryRun = await runtime.dryRunCall(
                            origin,
                            dest,
                            value,
                            undefined,
                            undefined,
                            calldata,
                        );
                        if (!dryRun.result.success) {
                            throw new ContractDryRunFailedError(methodName, dryRun.result.value);
                        }
                        weightLimit = weightLimit ?? dryRun.weight_required;
                        if (storageDepositLimit === undefined) {
                            storageDepositLimit =
                                dryRun.storage_deposit.type === "Charge"
                                    ? dryRun.storage_deposit.value
                                    : 0n;
                        }
                    }

                    const tx = runtime.api.tx.Revive.call({
                        dest,
                        value,
                        weight_limit: weightLimit,
                        storage_deposit_limit: storageDepositLimit,
                        data: calldata,
                    });

                    return submitAndWatch(tx, signer, {
                        waitFor: overrides?.waitFor,
                        timeoutMs: overrides?.timeoutMs,
                        mortalityPeriod: overrides?.mortalityPeriod,
                        onStatus: overrides?.onStatus,
                    });
                },
            };
        },
    }) as Contract<ContractDef>;
}

if (import.meta.vitest) {
    const { test, expect, describe } = import.meta.vitest;

    describe("buildMethodArgMap", () => {
        test("extracts function parameter names from ABI", () => {
            const abi: AbiEntry[] = [
                { type: "constructor", inputs: [], stateMutability: "nonpayable" },
                {
                    type: "function",
                    name: "transfer",
                    inputs: [
                        { name: "to", type: "address" },
                        { name: "amount", type: "uint256" },
                    ],
                    outputs: [{ name: "", type: "bool" }],
                },
                {
                    type: "function",
                    name: "balanceOf",
                    inputs: [{ name: "owner", type: "address" }],
                    outputs: [{ name: "", type: "uint256" }],
                },
                { type: "event", name: "Transfer", inputs: [] },
            ];
            expect(buildMethodArgMap(abi)).toEqual({
                transfer: ["to", "amount"],
                balanceOf: ["owner"],
            });
        });

        test("returns empty map for ABI with no functions", () => {
            const abi: AbiEntry[] = [
                { type: "constructor", inputs: [] },
                { type: "event", name: "Evt", inputs: [] },
            ];
            expect(buildMethodArgMap(abi)).toEqual({});
        });
    });

    describe("extractOverrides", () => {
        test("returns overrides when extra object arg is present", () => {
            const result = extractOverrides<{ origin: string }>(["a"], [42, { origin: "0x1" }]);
            expect(result.positionalArgs).toEqual([42]);
            expect(result.overrides).toEqual({ origin: "0x1" });
        });

        test("returns no overrides when arg count matches", () => {
            const result = extractOverrides(["a", "b"], [1, 2]);
            expect(result.positionalArgs).toEqual([1, 2]);
            expect(result.overrides).toBeUndefined();
        });

        test("does not treat array as overrides", () => {
            const result = extractOverrides(["a"], [1, [2, 3]]);
            expect(result.positionalArgs).toEqual([1, [2, 3]]);
            expect(result.overrides).toBeUndefined();
        });

        test("does not treat primitive as overrides", () => {
            const result = extractOverrides(["a"], [1, "extra"]);
            expect(result.positionalArgs).toEqual([1, "extra"]);
            expect(result.overrides).toBeUndefined();
        });
    });

    describe("normalizeContractAddress", () => {
        test("accepts 0x-prefixed H160", () => {
            expect(normalizeContractAddress("0x1234567890abcdef1234567890ABCDEF12345678")).toBe(
                "0x1234567890abcdef1234567890abcdef12345678",
            );
        });

        test("accepts unprefixed hex and re-adds the 0x prefix", () => {
            expect(normalizeContractAddress("aabbccddeeff00112233445566778899aabbccdd")).toBe(
                "0xaabbccddeeff00112233445566778899aabbccdd",
            );
        });

        test("rejects wrong length", () => {
            expect(() => normalizeContractAddress("0x1234")).toThrow(/20-byte/);
        });
    });

    describe("hexToBytes", () => {
        test("decodes 0x-prefixed hex to bytes", () => {
            expect(Array.from(hexToBytes("0xdeadbeef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
        });

        test("returns an empty array for the empty hex literal", () => {
            expect(hexToBytes("0x").byteLength).toBe(0);
        });
    });

    describe("encodeCalldata / decodeReturn (viem round-trip)", () => {
        const abi: AbiEntry[] = [
            {
                type: "function",
                name: "add",
                inputs: [
                    { name: "a", type: "uint32" },
                    { name: "b", type: "uint32" },
                ],
                outputs: [{ name: "", type: "uint32" }],
                stateMutability: "view",
            },
            {
                type: "function",
                name: "name",
                inputs: [],
                outputs: [{ name: "", type: "string" }],
                stateMutability: "view",
            },
        ];

        test("encodes selector + args", () => {
            const data = encodeCalldata(abi, "add", [1, 2]);
            expect(data.slice(0, 2)).toBe("0x");
            // 4-byte selector + 2 * 32-byte args = 68 bytes = 136 hex chars + "0x"
            expect(data.length).toBe(2 + 4 * 2 + 2 * 32 * 2);
        });

        test("decodes single uint32 return", () => {
            const buf = new Uint8Array(32);
            buf[31] = 7;
            expect(decodeReturn(abi, "add", buf)).toBe(7);
        });

        test("decodes string return", () => {
            const hex =
                "0000000000000000000000000000000000000000000000000000000000000020" +
                "0000000000000000000000000000000000000000000000000000000000000002" +
                "6869000000000000000000000000000000000000000000000000000000000000";
            const buf = new Uint8Array(hex.length / 2);
            for (let i = 0; i < buf.length; i++) {
                buf[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            }
            expect(decodeReturn(abi, "name", buf)).toBe("hi");
        });

        test("returns undefined for empty data", () => {
            expect(decodeReturn(abi, "add", new Uint8Array(0))).toBeUndefined();
        });
    });

    /** Minimal SignerManager mock for resolve* helpers. */
    function mockSigner(opts: {
        address?: string | null;
        signer?: PolkadotSigner | null;
    }): import("@parity/product-sdk-signer").SignerManager {
        return {
            getSigner: () => opts.signer ?? null,
            getState: () => ({
                selectedAccount: opts.address ? ({ address: opts.address } as never) : null,
            }),
        } as unknown as import("@parity/product-sdk-signer").SignerManager;
    }

    describe("resolveOrigin", () => {
        test("explicit override wins", () => {
            const defaults: ContractDefaults = {
                origin: "5Static" as SS58String,
                signerManager: mockSigner({ address: "5Source" }),
            };
            expect(resolveOrigin(defaults, "5Override" as SS58String)).toBe("5Override");
        });

        test("signerManager wins over static default", () => {
            const defaults: ContractDefaults = {
                origin: "5Static" as SS58String,
                signerManager: mockSigner({ address: "5Source" }),
            };
            expect(resolveOrigin(defaults)).toBe("5Source");
        });

        test("falls back to static default", () => {
            const defaults: ContractDefaults = { origin: "5Static" as SS58String };
            expect(resolveOrigin(defaults)).toBe("5Static");
        });

        test("returns undefined when nothing available", () => {
            expect(resolveOrigin({})).toBeUndefined();
        });
    });

    describe("resolveSigner", () => {
        const fakeSigner = { id: "fake" } as unknown as PolkadotSigner;
        const sourceSigner = { id: "source" } as unknown as PolkadotSigner;

        test("explicit override wins", () => {
            const defaults: ContractDefaults = {
                signer: { id: "static" } as unknown as PolkadotSigner,
                signerManager: mockSigner({ signer: sourceSigner }),
            };
            expect(resolveSigner(defaults, fakeSigner)).toBe(fakeSigner);
        });

        test("signerManager wins over static default", () => {
            const defaults: ContractDefaults = {
                signer: { id: "static" } as unknown as PolkadotSigner,
                signerManager: mockSigner({ signer: sourceSigner }),
            };
            expect(resolveSigner(defaults)).toBe(sourceSigner);
        });

        test("falls back to static default", () => {
            const defaults: ContractDefaults = { signer: fakeSigner };
            expect(resolveSigner(defaults)).toBe(fakeSigner);
        });

        test("returns undefined when nothing available", () => {
            expect(resolveSigner({})).toBeUndefined();
        });
    });

    describe("wrapContract — PAPI 2.x boundary (HexString / Uint8Array contract)", () => {
        // The codegen now emits `HexString` for `bytes` and `SizedHex<N>` for
        // `bytesN`. These tests pin the runtime side: when a caller passes a
        // hex string for those args, the SDK must hand PAPI a `0x…` `dest`
        // and a `Uint8Array` `data` — anything else trips PAPI 2.x's
        // `isCompatible` check or its codecs. We capture the arguments PAPI
        // receives and assert on their concrete shapes.
        const ADDRESS_INPUT = "0x0102030405060708090a0b0c0d0e0f1011121314";

        type Captured = {
            dryRun: Parameters<ContractRuntime["dryRunCall"]> | null;
            tx: { dest: unknown; data: unknown } | null;
        };

        function mockRuntime(captured: Captured): ContractRuntime {
            const successfulDryRun: ContractRuntime["dryRunCall"] = async (...args) => {
                captured.dryRun = args;
                return {
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 1n, proof_size: 1n },
                    storage_deposit: { type: "Charge", value: 7n },
                    max_storage_deposit: { type: "Charge", value: 7n },
                    gas_consumed: 0n,
                    result: { success: true, value: { flags: 0, data: new Uint8Array(0) } },
                };
            };
            return {
                api: {
                    tx: {
                        Revive: {
                            call: (args: { dest: unknown; data: unknown }) => {
                                captured.tx = { dest: args.dest, data: args.data };
                                return {
                                    signSubmitAndWatch: () => ({
                                        subscribe: (handlers: {
                                            next: (event: unknown) => void;
                                        }) => {
                                            queueMicrotask(() => {
                                                handlers.next({
                                                    type: "txBestBlocksState",
                                                    txHash: "0xdeadbeef",
                                                    found: true,
                                                    ok: true,
                                                    events: [],
                                                    block: {
                                                        hash: "0xblock",
                                                        number: 1,
                                                        index: 0,
                                                    },
                                                });
                                            });
                                            return { unsubscribe: () => {} };
                                        },
                                    }),
                                };
                            },
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: successfulDryRun,
            };
        }

        const fakeSigner = {
            publicKey: new Uint8Array(32),
        } as unknown as PolkadotSigner;
        const origin = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;

        test("`bytesN` argument: hex string is forwarded as 0x-string dest and Uint8Array calldata", async () => {
            // Solidity: function setHash(bytes32 hash) — exercises the
            // `bytesN` codegen branch (now `SizedHex<N>`). The argument here
            // is what a user following the generated types would pass.
            const abi: AbiEntry[] = [
                {
                    type: "function",
                    name: "setHash",
                    inputs: [{ name: "hash", type: "bytes32" }],
                    outputs: [],
                    stateMutability: "nonpayable",
                },
            ];

            const captured: Captured = { dryRun: null, tx: null };
            const wrapped = wrapContract(mockRuntime(captured), ADDRESS_INPUT, abi, {
                signer: fakeSigner,
                origin,
            });

            const hash = "0x1111111111111111111111111111111111111111111111111111111111111111";
            await (
                wrapped as unknown as { setHash: { tx: (h: string) => Promise<unknown> } }
            ).setHash.tx(hash);

            // PAPI's compat check rejects anything that isn't a `0x…` string
            // for an H160 dest. The class-based `FixedSizeBinary` would fail.
            expect(captured.dryRun?.[1]).toBe(ADDRESS_INPUT);
            expect(typeof captured.dryRun?.[1]).toBe("string");

            // Variable-length calldata must arrive as a `Uint8Array`. The
            // ABI selector for `setHash(bytes32)` is `0xa61eb053`, followed
            // by the 32-byte argument right-padded into a 32-byte word.
            const calldata = captured.dryRun?.[5] as Uint8Array;
            expect(calldata).toBeInstanceOf(Uint8Array);
            expect(calldata.byteLength).toBe(4 + 32);
            expect(Array.from(calldata.slice(4, 36))).toEqual(Array(32).fill(0x11));

            // The same pair flows into the typed extrinsic — a class instance
            // here would silently mis-encode under PAPI 2.x.
            expect(captured.tx?.dest).toBe(ADDRESS_INPUT);
            expect(captured.tx?.data).toBeInstanceOf(Uint8Array);
        });

        test("variable `bytes` argument: hex string round-trips through viem to Uint8Array calldata", async () => {
            // Solidity: function store(bytes data) — exercises the `bytes`
            // codegen branch (now `HexString`).
            const abi: AbiEntry[] = [
                {
                    type: "function",
                    name: "store",
                    inputs: [{ name: "data", type: "bytes" }],
                    outputs: [],
                    stateMutability: "nonpayable",
                },
            ];

            const captured: Captured = { dryRun: null, tx: null };
            const wrapped = wrapContract(mockRuntime(captured), ADDRESS_INPUT, abi, {
                signer: fakeSigner,
                origin,
            });

            await (
                wrapped as unknown as { store: { tx: (b: string) => Promise<unknown> } }
            ).store.tx("0xdeadbeef");

            const calldata = captured.dryRun?.[5] as Uint8Array;
            expect(calldata).toBeInstanceOf(Uint8Array);
            // Selector + length-32-word + offset-32-word + padded 4-byte payload (32-byte word).
            expect(calldata.byteLength).toBe(4 + 32 * 3);
            // 0xdeadbeef sits at the start of the third 32-byte word.
            const payloadStart = 4 + 32 * 2;
            expect(Array.from(calldata.slice(payloadStart, payloadStart + 4))).toEqual([
                0xde, 0xad, 0xbe, 0xef,
            ]);
        });

        test("query() decodes a `bytesN` return value back to the original hex string", async () => {
            // Solidity: function getHash() returns (bytes32). The dry-run
            // result's `data` is a raw `Uint8Array` under PAPI 2.x — wrap
            // must hand it to viem's decoder unwrapped.
            const abi: AbiEntry[] = [
                {
                    type: "function",
                    name: "getHash",
                    inputs: [],
                    outputs: [{ name: "", type: "bytes32" }],
                    stateMutability: "view",
                },
            ];

            // 32-byte word filled with 0x22 — what the chain returns for a
            // hypothetical `bytes32` reading.
            const responseBytes = new Uint8Array(32).fill(0x22);
            const runtime: ContractRuntime = {
                api: {} as unknown as ContractRuntime["api"],
                dryRunCall: async () => ({
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 0n, proof_size: 0n },
                    storage_deposit: { type: "Refund", value: 0n },
                    max_storage_deposit: { type: "Refund", value: 0n },
                    gas_consumed: 0n,
                    result: { success: true, value: { flags: 0, data: responseBytes } },
                }),
            };

            const wrapped = wrapContract(runtime, ADDRESS_INPUT, abi, { origin });
            const result = await (
                wrapped as unknown as {
                    getHash: { query: () => Promise<{ success: boolean; value: unknown }> };
                }
            ).getHash.query();

            expect(result.success).toBe(true);
            // viem decodes `bytes32` as a `0x…` hex string.
            expect(result.value).toBe(
                "0x2222222222222222222222222222222222222222222222222222222222222222",
            );
        });
    });

    describe("wrapContract — tx dry-run failure", () => {
        const abi: AbiEntry[] = [
            {
                type: "function",
                name: "increment",
                inputs: [],
                outputs: [],
                stateMutability: "nonpayable",
            },
        ];
        const ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
        const fakeSigner = {
            publicKey: new Uint8Array(32),
        } as unknown as PolkadotSigner;

        test("throws ContractDryRunFailedError when ReviveApi.call reports failure", async () => {
            const dispatchError = { type: "Module", value: { type: "ContractReverted" } };
            const failingDryRun: ContractRuntime["dryRunCall"] = async () => ({
                weight_consumed: { ref_time: 0n, proof_size: 0n },
                weight_required: { ref_time: 0n, proof_size: 0n },
                storage_deposit: { type: "Refund", value: 0n },
                max_storage_deposit: { type: "Refund", value: 0n },
                gas_consumed: 0n,
                result: { success: false, value: dispatchError },
            });
            const runtime: ContractRuntime = {
                api: {
                    apis: {
                        ReviveApi: {
                            call: () => {
                                throw new Error(
                                    "typed ReviveApi.call must NOT be invoked — runtime.dryRunCall owns the dry-run path",
                                );
                            },
                        },
                    },
                    tx: {
                        Revive: {
                            call: () => {
                                throw new Error(
                                    "Revive.call must NOT be invoked on dry-run failure",
                                );
                            },
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: failingDryRun,
            };

            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                signer: fakeSigner,
                origin: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String,
            });

            await expect(
                (
                    wrapped as unknown as { increment: { tx: () => Promise<unknown> } }
                ).increment.tx(),
            ).rejects.toMatchObject({
                name: "ContractDryRunFailedError",
                methodName: "increment",
                dispatchError,
            });
        });
    });
}
