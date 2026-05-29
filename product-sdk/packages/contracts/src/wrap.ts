// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { HexString, PolkadotSigner, SS58String } from "polkadot-api";
import {
    bytesToHex,
    decodeErrorResult,
    decodeFunctionResult,
    encodeFunctionData,
    type Abi as ViemAbi,
} from "viem";
import { submitAndWatch } from "@parity/product-sdk-tx";
import { createLogger } from "@parity/product-sdk-logger";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import {
    ContractDryRunFailedError,
    ContractRevertedError,
    ContractSignerMissingError,
    type ContractRevertInfo,
} from "./errors.js";
import type { ContractRuntime } from "./runtime.js";
import type { BatchableCall, SubmittableTransaction } from "@parity/product-sdk-tx";
import type {
    AbiEntry,
    Contract,
    ContractDef,
    ContractDefaults,
    PrepareOptions,
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
 * pallet-revive's own account, used as fallback origin for read-only queries
 * when no wallet is connected. The runtime API requires an origin, so we pass
 * this account when there is no connected one.
 *
 * This mirrors `Pallet::<T>::account_id()` in pallet-revive, which is
 * `PalletId(*b"py/reviv").into_account_truncating()`. The 32-byte AccountId is
 * the PalletId `TYPE_ID` (`b"modl"`) followed by the id (`b"py/reviv"`), zero
 * padded, i.e. `"modlpy/reviv"` + 20 trailing zero bytes.
 */
const REVIVE_PALLET_ACCOUNT = new Uint8Array(32);
REVIVE_PALLET_ACCOUNT.set(new TextEncoder().encode("modlpy/reviv"));
const QUERY_FALLBACK_ORIGIN = ss58Address(REVIVE_PALLET_ACCOUNT) as SS58String;

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
        log.warn("No origin configured — using pallet-revive account fallback for query dry-run");
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

// Bit 0 of `pallet-revive`'s `ReturnFlags`. Other bits are reserved, so we
// mask explicitly rather than checking `flags !== 0`.
const REVERT_FLAG = 1;

// Solidity panic codes that `Panic(uint256)` can carry. Stable across compiler
// versions; mapping them to a human-readable name beats showing the raw hex.
const PANIC_REASONS: Record<string, string> = {
    "0x01": "assertion failed",
    "0x11": "arithmetic overflow",
    "0x12": "division by zero",
    "0x21": "invalid enum value",
    "0x22": "improperly encoded storage byte array",
    "0x31": "pop on empty array",
    "0x32": "array index out of bounds",
    "0x41": "memory allocation overflow",
    "0x51": "call to uninitialized internal function",
};

/**
 * Adapt viem's `decodeErrorResult` output into our tagged `ContractRevertInfo`.
 * The core decode is viem's; this wrapper layers in a UTF-8 fallback for raw
 * `revert(bytes)` payloads and the panic-code-to-string mapping. viem's own
 * `panicReasons` and `ContractFunctionRevertedError` are unsuitable here:
 * `panicReasons` sits at `viem/constants/solidity` and isn't surfaced by
 * viem's `exports` map, and `ContractFunctionRevertedError` is shaped for
 * viem's call pipeline and would need adapting back into this shape anyway.
 */
function decodeRevert(abi: AbiEntry[], data: Uint8Array): ContractRevertInfo {
    const hex = bytesToHex(data);
    const info: ContractRevertInfo = {
        type: "ContractRevertedWithPayload",
        data: hex as HexString,
    };
    if (data.byteLength === 0) return info;
    try {
        // The ABI path wins even if a raw `revert(bytes)` payload happens to
        // start with `0x08c379a0` / `0x4e487b71` - astronomically rare on real
        // chains, but worth flagging for anyone debugging an oddly-decoded revert.
        const decoded = decodeErrorResult({
            abi: abi as unknown as ViemAbi,
            data: hex,
        });
        info.decoded = {
            errorName: decoded.errorName,
            args: decoded.args as readonly unknown[] | undefined,
        };
        if (decoded.errorName === "Error" && typeof decoded.args?.[0] === "string") {
            info.reason = decoded.args[0];
        } else if (decoded.errorName === "Panic" && typeof decoded.args?.[0] === "bigint") {
            const code = `0x${decoded.args[0].toString(16).padStart(2, "0")}`;
            info.reason = PANIC_REASONS[code] ? `Panic: ${PANIC_REASONS[code]}` : `Panic(${code})`;
        }
        return info;
    } catch {
        try {
            info.reason = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
            // Opaque bytes; expose only the raw hex.
        }
        return info;
    }
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
 *
 * Shape note: viem hands back the raw value for single-output methods and a
 * positional array for multi-output ones. The codegen pairs in
 * `generateMethodResponseType` surface multi-output returns as a named
 * object (`{name1: T1; name2: T2}`), so we assemble that object here from
 * viem's array. Single-output and Solidity-tuple outputs (which viem
 * already returns as a named object) pass through untouched.
 */
function decodeReturn(abi: AbiEntry[], methodName: string, returnData: Uint8Array): unknown {
    if (returnData.byteLength === 0) return undefined;
    const decoded = decodeFunctionResult({
        abi: abi as unknown as ViemAbi,
        functionName: methodName,
        data: bytesToHex(returnData),
    });

    const entry = abi.find((e) => e.type === "function" && e.name === methodName);
    const outputs = entry?.outputs ?? [];
    if (outputs.length <= 1 || !Array.isArray(decoded)) return decoded;
    // Fall back to positional `_0`, `_1`, … when outputs are unnamed —
    // matches generateMethodResponseType's naming policy.
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < outputs.length; i++) {
        obj[outputs[i].name || `_${i}`] = decoded[i];
    }
    return obj;
}

/**
 * Shared pre-submit pipeline for `.tx()` and `.prepare()`:
 *
 *   1. Encode the calldata via viem.
 *   2. If either gas/storage override is missing, dry-run via
 *      `runtime.dryRunCall` to size the missing limit(s) and fail fast on
 *      revert / OOG / `AccountNotMapped`. Skipped when both are provided.
 *   3. Build the `Revive.call` extrinsic via the typed API.
 *
 * Returned `SubmittableTransaction` is what `.tx()` hands to `submitAndWatch`
 * and what `.prepare()` returns as a `BatchableCall`.
 */
async function buildReviveCall(
    runtime: ContractRuntime,
    dest: HexString,
    abi: AbiEntry[],
    methodName: string,
    positionalArgs: unknown[],
    origin: SS58String,
    overrides: PrepareOptions | TxOptions | undefined,
): Promise<SubmittableTransaction> {
    const value = overrides?.value ?? 0n;
    const calldata = hexToBytes(encodeCalldata(abi, methodName, positionalArgs));

    let weightLimit = overrides?.gasLimit;
    let storageDepositLimit = overrides?.storageDepositLimit;
    // Passing both overrides skips the dry-run entirely - including the REVERT
    // pre-check. Callers who supply both are accepting that a reverting tx
    // would still be submitted and gas paid.
    if (weightLimit === undefined || storageDepositLimit === undefined) {
        const dryRun = await runtime.dryRunCall(
            origin,
            dest,
            value,
            undefined,
            undefined,
            calldata,
            overrides?.at !== undefined ? { at: overrides.at } : undefined,
        );
        if (!dryRun.result.success) {
            throw new ContractDryRunFailedError(methodName, dryRun.result.value);
        }
        if ((dryRun.result.value.flags & REVERT_FLAG) !== 0) {
            // Fail fast so callers don't pay gas on a call the chain already told us would revert.
            const { data, reason, decoded } = decodeRevert(abi, dryRun.result.value.data);
            log.debug("Contract reverted", { methodName, reason, errorName: decoded?.errorName });
            throw new ContractRevertedError(methodName, data, { reason, decoded });
        }
        weightLimit = weightLimit ?? dryRun.weight_required;
        if (storageDepositLimit === undefined) {
            storageDepositLimit =
                dryRun.storage_deposit.type === "Charge" ? dryRun.storage_deposit.value : 0n;
        }
    }

    return runtime.api.tx.Revive.call({
        dest,
        value,
        weight_limit: weightLimit,
        storage_deposit_limit: storageDepositLimit,
        data: calldata,
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
                        overrides?.at !== undefined ? { at: overrides.at } : undefined,
                    );

                    if (!dryRun.result.success) {
                        // Pass the dispatch-error payload through. `value`
                        // typically narrows as a tagged enum (e.g.
                        // `{ type: "Module", value: ... }`,
                        // `{ type: "ContractReverted" }`,
                        // `{ type: "AccountNotMapped" }`) — callers inspect
                        // its shape to learn why the call failed instead of
                        // receiving a bare `undefined` with no signal.
                        return {
                            success: false,
                            value: dryRun.result.value,
                            gasRequired: dryRun.weight_required,
                        };
                    }

                    if ((dryRun.result.value.flags & REVERT_FLAG) !== 0) {
                        // Surface as a tagged value; decoding revert bytes as a normal return would throw.
                        const info = decodeRevert(abi, dryRun.result.value.data);
                        log.debug("Contract reverted", {
                            methodName,
                            reason: info.reason,
                            errorName: info.decoded?.errorName,
                        });
                        return {
                            success: false,
                            value: info,
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

                    const tx = await buildReviveCall(
                        runtime,
                        dest,
                        abi,
                        methodName,
                        positionalArgs,
                        origin,
                        overrides,
                    );

                    return submitAndWatch(tx, signer, {
                        waitFor: overrides?.waitFor,
                        timeoutMs: overrides?.timeoutMs,
                        mortalityPeriod: overrides?.mortalityPeriod,
                        onStatus: overrides?.onStatus,
                    });
                },

                prepare: async (...args: unknown[]): Promise<BatchableCall> => {
                    // `.prepare()` builds the same `Revive.call` extrinsic as
                    // `.tx()` but stops before submission — the returned
                    // SubmittableTransaction is a BatchableCall consumable
                    // by `batchSubmitAndWatch`. Origin defaults to the
                    // pallet-revive account for the dry-run since no signer is
                    // required at prepare time; the batch's signer replaces the
                    // dispatched origin at submission.
                    const { positionalArgs, overrides } = extractOverrides<PrepareOptions>(
                        argNames,
                        args,
                    );
                    const origin = resolveOrigin(defaults, overrides?.origin, true)!;
                    return buildReviveCall(
                        runtime,
                        dest,
                        abi,
                        methodName,
                        positionalArgs,
                        origin,
                        overrides,
                    );
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

        test("multi-output method: assembles named object from viem's positional array", () => {
            // viem hands back `[balance, nonce]` for multi-output methods,
            // but `generateMethodResponseType` surfaces this as
            // `{ balance: bigint; nonce: bigint }`. decodeReturn should
            // bridge the two so the runtime shape matches the codegen type.
            const multiAbi: AbiEntry[] = [
                {
                    type: "function",
                    name: "info",
                    inputs: [],
                    outputs: [
                        { name: "balance", type: "uint256" },
                        { name: "nonce", type: "uint256" },
                    ],
                    stateMutability: "view",
                },
            ];
            const buf = new Uint8Array(64);
            buf[31] = 7;
            buf[63] = 11;
            expect(decodeReturn(multiAbi, "info", buf)).toEqual({ balance: 7n, nonce: 11n });
        });

        test("multi-output method with unnamed outputs: falls back to _0, _1, …", () => {
            // Mirrors generateMethodResponseType's `_${i}` policy when an
            // output has no name in the ABI.
            const unnamedAbi: AbiEntry[] = [
                {
                    type: "function",
                    name: "stats",
                    inputs: [],
                    outputs: [
                        { name: "", type: "uint256" },
                        { name: "", type: "uint256" },
                    ],
                    stateMutability: "view",
                },
            ];
            const buf = new Uint8Array(64);
            buf[31] = 1;
            buf[63] = 2;
            expect(decodeReturn(unnamedAbi, "stats", buf)).toEqual({ _0: 1n, _1: 2n });
        });

        test("Solidity tuple output: viem already returns a named object — pass through", () => {
            // Single tuple-type output: viem builds the named object itself
            // from the component names, so decodeReturn must not double-wrap.
            const tupleAbi: AbiEntry[] = [
                {
                    type: "function",
                    name: "info",
                    inputs: [],
                    outputs: [
                        {
                            name: "result",
                            type: "tuple",
                            components: [
                                { name: "balance", type: "uint256" },
                                { name: "nonce", type: "uint256" },
                            ],
                        },
                    ],
                    stateMutability: "view",
                },
            ];
            const buf = new Uint8Array(64);
            buf[31] = 7;
            buf[63] = 11;
            expect(decodeReturn(tupleAbi, "info", buf)).toEqual({ balance: 7n, nonce: 11n });
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

    describe("wrapContract — query .at option routing", () => {
        // The `.query()` per-call `at` override is the user-facing hook for
        // pinning a dry-run to a different block than the runtime default
        // (see issue #95). These tests pin the wiring: the `at` value
        // arrives at `runtime.dryRunCall` as its trailing options arg,
        // exactly when the caller passes it — and is absent otherwise so
        // the runtime default applies.
        const abi: AbiEntry[] = [
            {
                type: "function",
                name: "getCount",
                inputs: [],
                outputs: [{ name: "", type: "uint32" }],
                stateMutability: "view",
            },
        ];
        const ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
        const origin = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;

        function makeCapturingRuntime(): {
            runtime: ContractRuntime;
            calls: Array<Parameters<ContractRuntime["dryRunCall"]>>;
        } {
            const calls: Array<Parameters<ContractRuntime["dryRunCall"]>> = [];
            const runtime: ContractRuntime = {
                api: {} as unknown as ContractRuntime["api"],
                dryRunCall: (...args) => {
                    calls.push(args);
                    return Promise.resolve({
                        weight_consumed: { ref_time: 0n, proof_size: 0n },
                        weight_required: { ref_time: 0n, proof_size: 0n },
                        storage_deposit: { type: "Refund", value: 0n },
                        max_storage_deposit: { type: "Refund", value: 0n },
                        gas_consumed: 0n,
                        result: { success: true, value: { flags: 0, data: new Uint8Array(32) } },
                    });
                },
            };
            return { runtime, calls };
        }

        test("forwards `at: finalized` to dryRunCall when passed per call", async () => {
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, { origin });
            await (
                wrapped as unknown as {
                    getCount: { query: (opts: { at: string }) => Promise<unknown> };
                }
            ).getCount.query({ at: "finalized" });
            expect(calls[0]?.[6]).toEqual({ at: "finalized" });
        });

        test("forwards a block hash `at` value to dryRunCall", async () => {
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, { origin });
            const blockHash = `0x${"cd".repeat(32)}` as `0x${string}`;
            await (
                wrapped as unknown as {
                    getCount: { query: (opts: { at: string }) => Promise<unknown> };
                }
            ).getCount.query({ at: blockHash });
            expect(calls[0]?.[6]).toEqual({ at: blockHash });
        });

        test("omits the options argument when no `at` override is passed", async () => {
            // No per-call override ⇒ the wrap layer must not synthesise an
            // options object; the runtime applies its own default.
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, { origin });
            await (
                wrapped as unknown as { getCount: { query: () => Promise<unknown> } }
            ).getCount.query();
            expect(calls[0]?.[6]).toBeUndefined();
        });

        test("omits options when only unrelated overrides are passed", async () => {
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, { origin });
            await (
                wrapped as unknown as {
                    getCount: { query: (opts: { value: bigint }) => Promise<unknown> };
                }
            ).getCount.query({ value: 1n });
            expect(calls[0]?.[6]).toBeUndefined();
        });
    });

    describe("wrapContract — tx/prepare .at option routing", () => {
        // The `.tx()` and `.prepare()` per-call `at` override pins the
        // sizing dry-run to a specific block. Same wiring as `.query()` —
        // these tests assert the value arrives at `runtime.dryRunCall` as
        // its trailing options arg, and is absent otherwise so the
        // runtime default applies.
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
        const origin = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;
        const fakeSigner = {
            publicKey: new Uint8Array(32),
        } as unknown as PolkadotSigner;

        function makeCapturingRuntime(): {
            runtime: ContractRuntime;
            calls: Array<Parameters<ContractRuntime["dryRunCall"]>>;
        } {
            const calls: Array<Parameters<ContractRuntime["dryRunCall"]>> = [];
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: () =>
                                ({}) as unknown as Awaited<
                                    ReturnType<ContractRuntime["api"]["tx"]["Revive"]["call"]>
                                >,
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: (...args) => {
                    calls.push(args);
                    return Promise.resolve({
                        weight_consumed: { ref_time: 0n, proof_size: 0n },
                        weight_required: { ref_time: 0n, proof_size: 0n },
                        storage_deposit: { type: "Refund", value: 0n },
                        max_storage_deposit: { type: "Refund", value: 0n },
                        gas_consumed: 0n,
                        result: { success: true, value: { flags: 0, data: new Uint8Array(0) } },
                    });
                },
            };
            return { runtime, calls };
        }

        test(".tx() forwards `at: finalized` to dryRunCall when passed per call", async () => {
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                origin,
                signer: fakeSigner,
            });
            await (
                wrapped as unknown as {
                    increment: { tx: (opts: { at: string }) => Promise<unknown> };
                }
            ).increment
                .tx({ at: "finalized" })
                .catch(() => {
                    // submit downstream of dryRunCall is irrelevant — only
                    // care that the dry-run captured the `at` value.
                });
            expect(calls[0]?.[6]).toEqual({ at: "finalized" });
        });

        test(".tx() forwards a block hash `at` value to dryRunCall", async () => {
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                origin,
                signer: fakeSigner,
            });
            const blockHash = `0x${"cd".repeat(32)}` as `0x${string}`;
            await (
                wrapped as unknown as {
                    increment: { tx: (opts: { at: string }) => Promise<unknown> };
                }
            ).increment
                .tx({ at: blockHash })
                .catch(() => {});
            expect(calls[0]?.[6]).toEqual({ at: blockHash });
        });

        test(".tx() omits the options argument when no `at` override is passed", async () => {
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                origin,
                signer: fakeSigner,
            });
            await (wrapped as unknown as { increment: { tx: () => Promise<unknown> } }).increment
                .tx()
                .catch(() => {});
            expect(calls[0]?.[6]).toBeUndefined();
        });

        test(".tx() omits options when only unrelated overrides are passed", async () => {
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                origin,
                signer: fakeSigner,
            });
            await (
                wrapped as unknown as {
                    increment: { tx: (opts: { value: bigint }) => Promise<unknown> };
                }
            ).increment
                .tx({ value: 1n })
                .catch(() => {});
            expect(calls[0]?.[6]).toBeUndefined();
        });

        test(".prepare() forwards `at: finalized` to dryRunCall", async () => {
            // `.prepare()` shares `buildReviveCall` with `.tx()`; one
            // smoke test pins that `PrepareOptions.at` is wired too.
            const { runtime, calls } = makeCapturingRuntime();
            const wrapped = wrapContract(runtime, ADDRESS, abi, { origin });
            await (
                wrapped as unknown as {
                    increment: { prepare: (opts: { at: string }) => Promise<unknown> };
                }
            ).increment
                .prepare({ at: "finalized" })
                .catch(() => {});
            expect(calls[0]?.[6]).toEqual({ at: "finalized" });
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

        test("skips dry-run entirely when both gasLimit and storageDepositLimit overrides are passed", async () => {
            // When the caller supplies both weight and storage-deposit
            // overrides, `.tx()` should go straight to the extrinsic builder
            // — no RPC round-trip, no revert pre-check. We assert this by
            // wiring both `dryRunCall` and `apis.ReviveApi.call` to throw if
            // invoked, and checking the tx still lands.
            let txArgs: { weight_limit: unknown; storage_deposit_limit: unknown } | null = null;
            const runtime: ContractRuntime = {
                api: {
                    apis: {
                        ReviveApi: {
                            call: () => {
                                throw new Error(
                                    "ReviveApi.call must NOT be invoked when both overrides are passed",
                                );
                            },
                        },
                    },
                    tx: {
                        Revive: {
                            call: (args: {
                                weight_limit: unknown;
                                storage_deposit_limit: unknown;
                            }) => {
                                txArgs = {
                                    weight_limit: args.weight_limit,
                                    storage_deposit_limit: args.storage_deposit_limit,
                                };
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
                dryRunCall: () => {
                    throw new Error(
                        "dryRunCall must NOT be invoked when both overrides are passed",
                    );
                },
            };

            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                signer: fakeSigner,
                origin: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String,
            });

            const overrideWeight = { ref_time: 1234n, proof_size: 56n };
            const overrideDeposit = 7890n;
            await (
                wrapped as unknown as {
                    increment: { tx: (opts: unknown) => Promise<unknown> };
                }
            ).increment.tx({
                gasLimit: overrideWeight,
                storageDepositLimit: overrideDeposit,
            });

            expect(txArgs).toEqual({
                weight_limit: overrideWeight,
                storage_deposit_limit: overrideDeposit,
            });
        });

        test("missing storageDepositLimit override still triggers the dry-run", async () => {
            // Half-overrides don't bypass: if the caller passes `gasLimit`
            // but not `storageDepositLimit`, the SDK must still dry-run to
            // size the deposit AND to fail fast on revert. The previous
            // `!weightLimit` check was correct here; the tightening to
            // `=== undefined` keeps this branch intact for any future
            // refactor that touches the guard.
            let dryRunInvoked = false;
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: () => {
                                throw new Error("Revive.call must not run — dry-run failed");
                            },
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: async () => {
                    dryRunInvoked = true;
                    return {
                        weight_consumed: { ref_time: 0n, proof_size: 0n },
                        weight_required: { ref_time: 0n, proof_size: 0n },
                        storage_deposit: { type: "Refund", value: 0n },
                        max_storage_deposit: { type: "Refund", value: 0n },
                        gas_consumed: 0n,
                        result: { success: false, value: { type: "ContractReverted" } },
                    };
                },
            };

            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                signer: fakeSigner,
                origin: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String,
            });

            await expect(
                (
                    wrapped as unknown as {
                        increment: { tx: (opts: unknown) => Promise<unknown> };
                    }
                ).increment.tx({ gasLimit: { ref_time: 1n, proof_size: 1n } }),
            ).rejects.toMatchObject({ name: "ContractDryRunFailedError" });
            expect(dryRunInvoked).toBe(true);
        });
    });

    describe("wrapContract — prepare (batch composition)", () => {
        // `.prepare()` is the revive-runtime port of the polkadot-apps
        // batching helper. These tests pin the contract the rest of the
        // SDK relies on:
        //
        //   - returns a `SubmittableTransaction` that doubles as a
        //     `BatchableCall` (has `.decodedCall` / forwards through
        //     `batchSubmitAndWatch`'s `resolveDecodedCall`),
        //   - never invokes `submitAndWatch`,
        //   - sizes weight + storage via the dry-run unless the caller
        //     supplies both overrides,
        //   - bubbles a dry-run failure as `ContractDryRunFailedError`
        //     before the extrinsic is built,
        //   - requires no signer (the batch's signer dispatches).
        const abi: AbiEntry[] = [
            {
                type: "function",
                name: "increment",
                inputs: [],
                outputs: [],
                stateMutability: "nonpayable",
            },
            {
                type: "function",
                name: "add",
                inputs: [{ name: "n", type: "uint32" }],
                outputs: [],
                stateMutability: "nonpayable",
            },
        ];
        const ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";

        test("builds a Revive.call submittable without signing or dry-running when both overrides given", async () => {
            let txArgs: {
                dest: unknown;
                value: unknown;
                weight_limit: unknown;
                storage_deposit_limit: unknown;
                data: unknown;
            } | null = null;
            const captured: { dryRun: boolean } = { dryRun: false };
            const sentinelDecodedCall = { pallet: "Revive", call: "call" };
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: (args: typeof txArgs) => {
                                txArgs = args;
                                // Real PAPI returns a SubmittableTransaction
                                // with `.decodedCall`; the field is what
                                // `batchSubmitAndWatch` reads to assemble
                                // the `Utility.batch_all` payload.
                                return {
                                    decodedCall: sentinelDecodedCall,
                                    signSubmitAndWatch: () => {
                                        throw new Error(
                                            "prepare must NOT sign or submit — caller batches the result",
                                        );
                                    },
                                };
                            },
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: async () => {
                    captured.dryRun = true;
                    throw new Error("prepare must NOT dry-run when both overrides are given");
                },
            };
            const wrapped = wrapContract(runtime, ADDRESS, abi, {});

            const overrideWeight = { ref_time: 99n, proof_size: 11n };
            const result = await (
                wrapped as unknown as {
                    add: {
                        prepare: (n: number, opts: unknown) => Promise<{ decodedCall: unknown }>;
                    };
                }
            ).add.prepare(7, {
                gasLimit: overrideWeight,
                storageDepositLimit: 42n,
                value: 5n,
            });

            // SubmittableTransaction is a valid BatchableCall —
            // `batchSubmitAndWatch` reads `.decodedCall` off it.
            expect(result.decodedCall).toBe(sentinelDecodedCall);

            // Override values flowed straight through to the extrinsic.
            expect(txArgs).toEqual({
                dest: ADDRESS,
                value: 5n,
                weight_limit: overrideWeight,
                storage_deposit_limit: 42n,
                // viem-encoded `add(uint32)` calldata: 4-byte selector +
                // 32-byte argument. We don't assert the byte-level layout
                // here (covered in the bytesN boundary tests).
                data: expect.any(Uint8Array),
            });
            expect(captured.dryRun).toBe(false);
        });

        test("dry-runs to fill the missing limits when overrides are partial", async () => {
            let dryRunCalls = 0;
            const txArgs: { weight_limit: unknown; storage_deposit_limit: unknown }[] = [];
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: (args: {
                                weight_limit: unknown;
                                storage_deposit_limit: unknown;
                            }) => {
                                txArgs.push(args);
                                return { decodedCall: { sentinel: true } };
                            },
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: async () => {
                    dryRunCalls += 1;
                    return {
                        weight_consumed: { ref_time: 0n, proof_size: 0n },
                        weight_required: { ref_time: 123n, proof_size: 7n },
                        storage_deposit: { type: "Charge", value: 99n },
                        max_storage_deposit: { type: "Charge", value: 99n },
                        gas_consumed: 0n,
                        result: { success: true, value: { flags: 0, data: new Uint8Array(0) } },
                    };
                },
            };
            const wrapped = wrapContract(runtime, ADDRESS, abi, {});

            // Only gasLimit override → dry-run still fires to size storage.
            await (
                wrapped as unknown as {
                    increment: { prepare: (opts?: unknown) => Promise<unknown> };
                }
            ).increment.prepare({ gasLimit: { ref_time: 10n, proof_size: 1n } });

            // Only storageDepositLimit → dry-run still fires to size weight.
            await (
                wrapped as unknown as {
                    increment: { prepare: (opts?: unknown) => Promise<unknown> };
                }
            ).increment.prepare({ storageDepositLimit: 0n });

            // Nothing → dry-run fills both.
            await (
                wrapped as unknown as {
                    increment: { prepare: (opts?: unknown) => Promise<unknown> };
                }
            ).increment.prepare();

            expect(dryRunCalls).toBe(3);
            // First call kept the gasLimit override; second kept the
            // storageDepositLimit override; third filled both from the
            // dry-run result.
            expect(txArgs[0]?.weight_limit).toEqual({ ref_time: 10n, proof_size: 1n });
            expect(txArgs[0]?.storage_deposit_limit).toBe(99n);
            expect(txArgs[1]?.weight_limit).toEqual({ ref_time: 123n, proof_size: 7n });
            expect(txArgs[1]?.storage_deposit_limit).toBe(0n);
            expect(txArgs[2]?.weight_limit).toEqual({ ref_time: 123n, proof_size: 7n });
            expect(txArgs[2]?.storage_deposit_limit).toBe(99n);
        });

        test("does not require a signer; falls back to dev origin for the dry-run", async () => {
            let capturedOrigin: string | undefined;
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: () => ({ decodedCall: { sentinel: true } }),
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: async (origin) => {
                    capturedOrigin = origin;
                    return {
                        weight_consumed: { ref_time: 0n, proof_size: 0n },
                        weight_required: { ref_time: 1n, proof_size: 1n },
                        storage_deposit: { type: "Refund", value: 0n },
                        max_storage_deposit: { type: "Refund", value: 0n },
                        gas_consumed: 0n,
                        result: { success: true, value: { flags: 0, data: new Uint8Array(0) } },
                    };
                },
            };
            // No signer / signerManager / defaultOrigin set.
            const wrapped = wrapContract(runtime, ADDRESS, abi, {});

            await expect(
                (
                    wrapped as unknown as {
                        increment: { prepare: () => Promise<unknown> };
                    }
                ).increment.prepare(),
            ).resolves.toMatchObject({ decodedCall: { sentinel: true } });

            // Origin must have been resolved without throwing — falls
            // back to the pallet-revive account for the dry-run.
            expect(capturedOrigin).toBe(QUERY_FALLBACK_ORIGIN);
        });

        test("throws ContractDryRunFailedError before constructing the extrinsic on revert", async () => {
            const dispatchError = { type: "Module", value: { type: "ContractReverted" } };
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: () => {
                                throw new Error(
                                    "Revive.call must NOT be invoked on a failing dry-run",
                                );
                            },
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: async () => ({
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 0n, proof_size: 0n },
                    storage_deposit: { type: "Refund", value: 0n },
                    max_storage_deposit: { type: "Refund", value: 0n },
                    gas_consumed: 0n,
                    result: { success: false, value: dispatchError },
                }),
            };
            const wrapped = wrapContract(runtime, ADDRESS, abi, {});

            await expect(
                (
                    wrapped as unknown as { increment: { prepare: () => Promise<unknown> } }
                ).increment.prepare(),
            ).rejects.toMatchObject({
                name: "ContractDryRunFailedError",
                methodName: "increment",
                dispatchError,
            });
        });

        test("prepared calls flow through batchSubmitAndWatch end-to-end", async () => {
            // Asserts the integration contract: two prepared calls
            // resolve into a `Utility.batch_all({ calls: [...] })`
            // payload of their `.decodedCall` values.
            const { batchSubmitAndWatch } = await import("@parity/product-sdk-tx");
            const decodedCalls = [
                { pallet: "Revive", method: "call", value: "one" },
                { pallet: "Revive", method: "call", value: "two" },
            ];
            let nextCall = 0;
            const runtime: ContractRuntime = {
                api: {
                    tx: {
                        Revive: {
                            call: () => ({ decodedCall: decodedCalls[nextCall++] }),
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: async () => ({
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 1n, proof_size: 1n },
                    storage_deposit: { type: "Refund", value: 0n },
                    max_storage_deposit: { type: "Refund", value: 0n },
                    gas_consumed: 0n,
                    result: { success: true, value: { flags: 0, data: new Uint8Array(0) } },
                }),
            };
            const wrapped = wrapContract(runtime, ADDRESS, abi, {});

            const a = await (
                wrapped as unknown as { increment: { prepare: () => Promise<BatchableCall> } }
            ).increment.prepare();
            const b = await (
                wrapped as unknown as {
                    add: { prepare: (n: number) => Promise<BatchableCall> };
                }
            ).add.prepare(1);

            let batchCalls: unknown[] | null = null;
            const fakeApi = {
                tx: {
                    Utility: {
                        batch_all: (args: { calls: unknown[] }) => {
                            batchCalls = args.calls;
                            return {
                                signSubmitAndWatch: () => ({
                                    subscribe: (h: {
                                        next: (event: unknown) => void;
                                    }) => {
                                        queueMicrotask(() => {
                                            h.next({
                                                type: "txBestBlocksState",
                                                txHash: "0xb",
                                                found: true,
                                                ok: true,
                                                events: [],
                                                block: {
                                                    hash: "0xblk",
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
            } as unknown as Parameters<typeof batchSubmitAndWatch>[1];

            const result = await batchSubmitAndWatch([a, b], fakeApi, {
                publicKey: new Uint8Array(32),
            } as unknown as Parameters<typeof batchSubmitAndWatch>[2]);

            expect(result.ok).toBe(true);
            expect(batchCalls).toEqual(decodedCalls);
        });
    });

    describe("decodeRevert", () => {
        const abi: AbiEntry[] = [
            {
                type: "error",
                name: "InsufficientBalance",
                inputs: [
                    { name: "needed", type: "uint256" },
                    { name: "available", type: "uint256" },
                ],
            },
        ];

        test("decodes a standard Error(string) revert and lifts the reason", () => {
            // 0x08c379a0 selector + ABI-encoded "Whoops".
            const hex =
                "0x08c379a0" +
                "0000000000000000000000000000000000000000000000000000000000000020" +
                "0000000000000000000000000000000000000000000000000000000000000006" +
                "57686f6f70730000000000000000000000000000000000000000000000000000";
            const bytes = hexToBytes(hex as HexString);
            const info = decodeRevert([], bytes);
            expect(info.type).toBe("ContractRevertedWithPayload");
            expect(info.reason).toBe("Whoops");
            expect(info.decoded?.errorName).toBe("Error");
        });

        test("decodes Panic(uint256) and names well-known codes", () => {
            // 0x4e487b71 selector + panic code 0x11 (arithmetic overflow).
            const hex = `0x4e487b71${"00".repeat(31)}11`;
            const info = decodeRevert([], hexToBytes(hex as HexString));
            expect(info.decoded?.errorName).toBe("Panic");
            expect(info.reason).toBe("Panic: arithmetic overflow");
        });

        test("decodes Panic(uint256) for unknown codes by falling back to the hex code", () => {
            // 0x4e487b71 selector + panic code 0xff (not a Solidity-defined code).
            const hex = `0x4e487b71${"00".repeat(31)}ff`;
            const info = decodeRevert([], hexToBytes(hex as HexString));
            expect(info.decoded?.errorName).toBe("Panic");
            expect(info.reason).toBe("Panic(0xff)");
        });

        test("decodes an ABI-defined custom error", () => {
            // InsufficientBalance(uint256,uint256) selector + (1, 2).
            const hex =
                "0xcf479181" +
                "0000000000000000000000000000000000000000000000000000000000000001" +
                "0000000000000000000000000000000000000000000000000000000000000002";
            const info = decodeRevert(abi, hexToBytes(hex as HexString));
            expect(info.decoded?.errorName).toBe("InsufficientBalance");
            expect(info.decoded?.args).toEqual([1n, 2n]);
            expect(info.reason).toBeUndefined();
        });

        test("falls back to a UTF-8 reason on raw revert(bytes) payloads", () => {
            const bytes = hexToBytes("0x556e617574686f72697a6564" as HexString);
            const info = decodeRevert([], bytes);
            expect(info.decoded).toBeUndefined();
            expect(info.reason).toBe("Unauthorized");
            expect(info.data).toBe("0x556e617574686f72697a6564");
        });

        test("leaves reason undefined for opaque non-UTF8 bytes", () => {
            const info = decodeRevert([], new Uint8Array([0xff, 0xfe, 0xfd]));
            expect(info.decoded).toBeUndefined();
            expect(info.reason).toBeUndefined();
            expect(info.data).toBe("0xfffefd");
        });

        test("empty payload produces a bare ContractRevertedWithPayload with no extras", () => {
            const info = decodeRevert([], new Uint8Array(0));
            expect(info).toEqual({ type: "ContractRevertedWithPayload", data: "0x" });
        });
    });

    describe("wrapContract — REVERT flag handling", () => {
        const abi: AbiEntry[] = [
            {
                type: "function",
                name: "transfer",
                inputs: [
                    { name: "to", type: "address" },
                    { name: "amount", type: "uint256" },
                ],
                outputs: [{ name: "", type: "bool" }],
                stateMutability: "nonpayable",
            },
            {
                type: "function",
                name: "ping",
                inputs: [],
                outputs: [],
                stateMutability: "nonpayable",
            },
        ];
        const ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
        const ORIGIN = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String;
        const fakeSigner = {
            publicKey: new Uint8Array(32),
        } as unknown as PolkadotSigner;

        const REVERT_PAYLOAD = hexToBytes("0x556e617574686f72697a6564" as HexString);

        function revertingRuntime(data: Uint8Array = REVERT_PAYLOAD): ContractRuntime {
            return {
                api: {
                    tx: {
                        Revive: {
                            call: () => {
                                throw new Error(
                                    "Revive.call must NOT be invoked when the dry-run reverts",
                                );
                            },
                        },
                    },
                } as unknown as ContractRuntime["api"],
                dryRunCall: async () => ({
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 5n, proof_size: 5n },
                    storage_deposit: { type: "Refund", value: 0n },
                    max_storage_deposit: { type: "Refund", value: 0n },
                    gas_consumed: 0n,
                    result: {
                        success: true,
                        value: { flags: 1, data },
                    },
                }),
            };
        }

        test("query() returns success:false with a ContractReverted value when REVERT bit is set", async () => {
            const wrapped = wrapContract(revertingRuntime(), ADDRESS, abi, {
                signer: fakeSigner,
                origin: ORIGIN,
            });

            const result = await (
                wrapped as unknown as {
                    transfer: {
                        query: (
                            to: string,
                            amount: bigint,
                        ) => Promise<{ success: boolean; value: unknown; gasRequired: unknown }>;
                    };
                }
            ).transfer.query("0x0000000000000000000000000000000000000001", 1n);

            expect(result.success).toBe(false);
            expect(result.value).toEqual({
                type: "ContractRevertedWithPayload",
                data: "0x556e617574686f72697a6564",
                reason: "Unauthorized",
            });
            expect(result.gasRequired).toEqual({ ref_time: 5n, proof_size: 5n });
        });

        test("query() handles an empty revert payload end-to-end (revert with no message)", async () => {
            const wrapped = wrapContract(revertingRuntime(new Uint8Array(0)), ADDRESS, abi, {
                signer: fakeSigner,
                origin: ORIGIN,
            });
            const result = await (
                wrapped as unknown as {
                    ping: {
                        query: () => Promise<{ success: boolean; value: unknown }>;
                    };
                }
            ).ping.query();

            expect(result.success).toBe(false);
            expect(result.value).toEqual({ type: "ContractRevertedWithPayload", data: "0x" });
        });

        test("tx() throws ContractRevertedError before signing when the dry-run reverts", async () => {
            const wrapped = wrapContract(revertingRuntime(), ADDRESS, abi, {
                signer: fakeSigner,
                origin: ORIGIN,
            });

            await expect(
                (
                    wrapped as unknown as {
                        transfer: {
                            tx: (to: string, amount: bigint) => Promise<unknown>;
                        };
                    }
                ).transfer.tx("0x0000000000000000000000000000000000000001", 1n),
            ).rejects.toMatchObject({
                name: "ContractRevertedError",
                methodName: "transfer",
                data: "0x556e617574686f72697a6564",
                reason: "Unauthorized",
            });
        });

        test("prepare() throws ContractRevertedError before constructing the extrinsic", async () => {
            const wrapped = wrapContract(revertingRuntime(), ADDRESS, abi, {});

            await expect(
                (
                    wrapped as unknown as {
                        transfer: {
                            prepare: (to: string, amount: bigint) => Promise<unknown>;
                        };
                    }
                ).transfer.prepare("0x0000000000000000000000000000000000000001", 1n),
            ).rejects.toMatchObject({
                name: "ContractRevertedError",
                methodName: "transfer",
                reason: "Unauthorized",
            });
        });

        test("revert with a standard Error(string) payload lifts the reason", async () => {
            // Solidity `require(false, "nope")`.
            const errorBytes = hexToBytes(
                ("0x08c379a0" +
                    "0000000000000000000000000000000000000000000000000000000000000020" +
                    "0000000000000000000000000000000000000000000000000000000000000004" +
                    "6e6f706500000000000000000000000000000000000000000000000000000000") as HexString,
            );
            const runtime: ContractRuntime = {
                api: {} as unknown as ContractRuntime["api"],
                dryRunCall: async () => ({
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 1n, proof_size: 1n },
                    storage_deposit: { type: "Refund", value: 0n },
                    max_storage_deposit: { type: "Refund", value: 0n },
                    gas_consumed: 0n,
                    result: { success: true, value: { flags: 1, data: errorBytes } },
                }),
            };
            const wrapped = wrapContract(runtime, ADDRESS, abi, {
                signer: fakeSigner,
                origin: ORIGIN,
            });
            const result = await (
                wrapped as unknown as {
                    transfer: {
                        query: (
                            to: string,
                            amount: bigint,
                        ) => Promise<{ success: boolean; value: { reason?: string } }>;
                    };
                }
            ).transfer.query("0x0000000000000000000000000000000000000001", 1n);
            expect(result.success).toBe(false);
            expect(result.value.reason).toBe("nope");
        });

        test("REVERT bit cleared stays on the happy path - normal return value is decoded", async () => {
            const returnBytes = new Uint8Array(32);
            returnBytes[31] = 1; // bool true
            const runtime: ContractRuntime = {
                api: {} as unknown as ContractRuntime["api"],
                dryRunCall: async () => ({
                    weight_consumed: { ref_time: 0n, proof_size: 0n },
                    weight_required: { ref_time: 1n, proof_size: 1n },
                    storage_deposit: { type: "Refund", value: 0n },
                    max_storage_deposit: { type: "Refund", value: 0n },
                    gas_consumed: 0n,
                    result: { success: true, value: { flags: 0, data: returnBytes } },
                }),
            };
            const wrapped = wrapContract(runtime, ADDRESS, abi, { origin: ORIGIN });
            const result = await (
                wrapped as unknown as {
                    transfer: {
                        query: (
                            to: string,
                            amount: bigint,
                        ) => Promise<{ success: boolean; value: unknown }>;
                    };
                }
            ).transfer.query("0x0000000000000000000000000000000000000001", 1n);
            expect(result.success).toBe(true);
            expect(result.value).toBe(true);
        });
    });
}
